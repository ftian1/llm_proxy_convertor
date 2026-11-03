#!/usr/bin/env node
/**
 * LLM Gateway —— 一个带日志记录的反向代理
 *
 * 用途:
 *   - Claude Code CLI / Codex CLI 把 base_url 指向本 gateway
 *   - gateway 记录并打印出站 HTTP 请求 payload 和响应内容
 *   - 再转发到指定的外部服务器 (UPSTREAM_URL + UPSTREAM_TOKEN, 两者都必填)
 *
 * 配置 (环境变量):
 *   UPSTREAM_URL  必填, 外部服务器地址, 例: https://api.deepseek.com 或 https://my.server.com/v1
 *   UPSTREAM_TOKEN 必填, 转发时使用的 Authorization: Bearer <token>
 *   GATEWAY_PORT  可选, 监听端口, 默认 18080
 *   LOG_FILE      可选, 若设置, 每条请求额外以 JSONL 形式追加写入该文件
 *   LOG_AUTH=1    可选, 在日志中明文显示 Authorization (默认脱敏)
 *   MAX_LOG_BYTES 可选, 单个 body 打印上限, 默认 262144 (256KB), 超出截断
 *   CONNECT_TIMEOUT_MS 可选, 代理拨号/CONNECT 超时, 默认 15000ms
 *   FIRST_BYTE_TIMEOUT_MS 可选, 上游首字节超时(仅约束响应到达前), 默认 120000ms
 *   GATEWAY_LOG_FILE 可选, 运行日志文件(内容与终端输出一致), 默认 gateway.log; 设 none 关闭
 *
 * 协议转换 (convert.js, 移植自 cc-switch), 默认全部开启 (设 0 关闭):
 *   CONVERT_ANTHROPIC  默认开启, 把 /v1/messages (Anthropic) 请求转换为 Chat Completions
 *   CONVERT_RESPONSES  默认开启, 把 /v1/responses 请求转换为 Chat Completions
 *   UPSTREAM_CHAT_PATH   可选, chat completions 端点的路径或完整 URL (可带 query),
 *                        默认由 UPSTREAM_URL 推导: 路径以 /v1 结尾时补 /chat/completions,
 *                        否则补 /v1/chat/completions
 *   ATTACH_REASONING=1   可选, 转换时把思考内容附到 assistant 消息的 reasoning_content
 *                        (DeepSeek/Kimi 等思考型上游要求; 严格 OpenAI 上游会拒绝该字段, 默认关闭)
 *   EMPTY_RESPONSE_MODE  可选, 上游返回空响应 (finish_reason=stop 但没有任何可见 content,
 *                        思考型模型只吐 reasoning、或 Azure 内容过滤拦截时常见) 的兜底方式。
 *                        一般不用设 —— 默认 auto 已经覆盖了思考型模型的场景:
 *                        auto (默认) 手里有思考内容就当正文回吐 (思考型模型把整段答案写进
 *                        reasoning 通道时能直接救回这一轮), 没有可回吐的则补一段可见说明
 *                        文本 | text 一律补说明文本 | error 报错中止本轮 (Anthropic 发
 *                        error 事件, Responses 发 response.failed; 仅流式 — 非流式没有
 *                        SSE 通道, 与 text 同行为) | pass 原样透传 (客户端会表现为
 *                        "Done 但没有输出")。两条协议 (anthropic/responses) 的流式与
 *                        非流式转换都生效
 *   EMPTY_RESPONSE_RETRIES 可选, 上游返回「完全空」响应 (零内容、零思考就
 *                        finish_reason=stop, 或零字节断流 —— deepseek-v4-pro 长上下文
 *                        偶发) 且还没向客户端写出任何帧时的透明重试次数, 默认 1
 *                        (最多重试一次, 共两次尝试), 设 0 关闭 (上限 3)。
 *                        仅流式转换生效: message_start / response.created 延迟到第一个
 *                        真实 delta 才发, 空响应在客户端眼里是零字节, 重试对客户端完全
 *                        透明; content_filter 拦截不重试 (重试无意义)
 *
 * 出站代理 (Node 核心 http/https 不会自动读代理环境变量, 需手动处理):
 *   GATEWAY_PROXY 可选, 强制指定代理, 例: http://proxy.host:912 (忽略 NO_PROXY)
 *                 不设置时自动使用 https_proxy/http_proxy/all_proxy (含大写形式),
 *                 no_proxy/NO_PROXY 旁路列表生效; https 上游走 CONNECT 隧道
 */
'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const tls = require('tls');
const dns = require('dns');
const fs = require('fs');
const util = require('util');
const { URL } = require('url');

const convert = require('./convert.js');

// ---------- 配置 ----------
const PORT = parseInt(process.env.GATEWAY_PORT || '18080', 10);
const UPSTREAM_URL = (process.env.UPSTREAM_URL || '').replace(/\/+$/, '');
const UPSTREAM_TOKEN = process.env.UPSTREAM_TOKEN || '';
const LOG_FILE = process.env.LOG_FILE || '';
const LOG_AUTH = process.env.LOG_AUTH === '1';
const MAX_LOG_BYTES = parseInt(process.env.MAX_LOG_BYTES || '262144', 10);
const CONNECT_TIMEOUT_MS = parseInt(process.env.CONNECT_TIMEOUT_MS || '15000', 10);
const FIRST_BYTE_TIMEOUT_MS = parseInt(process.env.FIRST_BYTE_TIMEOUT_MS || '120000', 10);
// 协议转换开关 (默认全开, 设 0 关闭 = 纯透传)
const CONVERT_ANTHROPIC = process.env.CONVERT_ANTHROPIC !== '0';
const CONVERT_RESPONSES = process.env.CONVERT_RESPONSES !== '0';
const ATTACH_REASONING = process.env.ATTACH_REASONING === '1';
const UPSTREAM_CHAT_PATH = process.env.UPSTREAM_CHAT_PATH || '';
// 上游返回空响应 (finish_reason=stop 但没有任何可见 content) 时的兜底:
//   auto 有思考内容就当正文回吐, 否则补说明文本 (默认, 无需配置) |
//   text 一律补说明文本 | error 用 Anthropic error 事件中止本轮 | pass 原样透传
const EMPTY_RESPONSE_MODE = process.env.EMPTY_RESPONSE_MODE || 'auto';
// 「完全空」响应 (零内容零思考就 stop/断流) 且客户端还没收到任何帧时的透明重试次数:
// 默认 1 (共两次尝试), 设 0 关闭, 上限 3 —— 只对"零字节已写出"的流式转换生效
const EMPTY_RESPONSE_RETRIES = Math.min(3,
  Math.max(0, parseInt(process.env.EMPTY_RESPONSE_RETRIES || '1', 10)));
// messages[] 里出现 role:"system" (Anthropic 规范不允许; Claude Code 会这么发后台任务
// 通知, 也会这么注入环境/CLAUDE.md 上下文) 时一律按 user 发送: 末条 system 会让上游
// chat 模板空响应; 中间位置 system 会被部分上游 (Qwen 兼容接口) 以
// 400 "System message must be at the beginning." 硬拒。NORMALIZE_INLINE_SYSTEM=0 可关闭。
const NORMALIZE_INLINE_SYSTEM = process.env.NORMALIZE_INLINE_SYSTEM !== '0';

// 空响应时把出站消息末段打出来, 便于定位到底是哪条 prompt 触发的
function outboundTailLines(outBody, n = 3, preview = 200) {
  let msgs;
  try {
    msgs = JSON.parse(outBody.toString('utf8')).messages;
  } catch {
    return ['(出站 body 解析失败)'];
  }
  if (!Array.isArray(msgs) || msgs.length === 0) return ['(无 messages)'];
  const lines = [];
  for (let i = Math.max(0, msgs.length - n); i < msgs.length; i += 1) {
    const m = msgs[i] || {};
    const raw = typeof m.content === 'string' ? m.content : JSON.stringify(m.content === undefined ? null : m.content);
    const flat = String(raw === null || raw === undefined ? '' : raw).replace(/\s+/g, ' ');
    lines.push(`#${i} ${m.role}(${flat.length}B): ${flat.slice(0, preview)}${flat.length > preview ? ' …' : ''}`);
  }
  return lines;
}

// 统计 Anthropic 请求 messages[] 中 role:"system" 的条数 (正常应为 0)
function countInlineSystemMessages(parsed) {
  if (!parsed || !Array.isArray(parsed.messages)) return 0;
  let n = 0;
  for (const m of parsed.messages) {
    if (m && m.role === 'system') n += 1;
  }
  return n;
}

// chat completions 出站目标: UPSTREAM_CHAT_PATH (路径或完整 URL) 优先, 否则由 UPSTREAM_URL 推导
function chatCompletionsTarget() {
  if (UPSTREAM_CHAT_PATH) {
    const raw = UPSTREAM_CHAT_PATH.trim();
    if (raw.startsWith('http://') || raw.startsWith('https://')) return new URL(raw);
    return new URL(UPSTREAM_URL + '/' + raw.replace(/^\/+/, ''));
  }
  const pathname = new URL(UPSTREAM_URL).pathname.replace(/\/+$/, '');
  const suffix = pathname.endsWith('/v1') ? '/chat/completions' : '/v1/chat/completions';
  return new URL(UPSTREAM_URL + suffix);
}

// 把路径中连续重复的 /v1 段折叠为一个: /v1/v1/messages → /v1/messages
// (客户端 ANTHROPIC_BASE_URL 误带 /v1、或透传时与 UPSTREAM_URL 自带的 /v1 拼出重复段都会出现;
//  真实 API 不会有连续 /v1 段, 折叠是安全的; 无重复时返回 null)
function collapseV1(pathname) {
  const collapsed = pathname.replace(/(\/v1){2,}/g, '/v1');
  return collapsed === pathname ? null : collapsed;
}

// ---------- 日志输出: 同时打印到 terminal 和文件 ----------
// 覆写 console.log/console.error, 让所有输出都镜像一份到 GATEWAY_LOG_FILE
const GATEWAY_LOG_FILE = process.env.GATEWAY_LOG_FILE || 'gateway.log';
let logFileStream = null;
if (!['none', 'off', '-'].includes(GATEWAY_LOG_FILE.toLowerCase())) {
  logFileStream = fs.createWriteStream(GATEWAY_LOG_FILE, { flags: 'a' });
  logFileStream.on('error', (e) => {
    process.stderr.write(`[WARN] 无法写入日志文件 ${GATEWAY_LOG_FILE}: ${e.message}\n`);
    logFileStream = null;
  });
}

function tee(writer) {
  return (...args) => {
    const line = util.format(...args) + '\n';
    writer(line);
    if (logFileStream) logFileStream.write(line);
  };
}
console.log = tee((s) => process.stdout.write(s));
console.error = tee((s) => process.stderr.write(s));

// 用户只需设置 UPSTREAM_URL 和 UPSTREAM_TOKEN, 缺了哪个都提示并退出
const missingEnv = [];
if (!UPSTREAM_URL) missingEnv.push('UPSTREAM_URL   上游地址, 例: UPSTREAM_URL=https://api.deepseek.com');
if (!UPSTREAM_TOKEN) missingEnv.push('UPSTREAM_TOKEN 上游 API key, 例: UPSTREAM_TOKEN=sk-xxx');
if (missingEnv.length) {
  console.error('FATAL: 缺少必填环境变量:');
  for (const m of missingEnv) console.error('  - ' + m);
  console.error('完整示例: UPSTREAM_URL=https://api.deepseek.com UPSTREAM_TOKEN=sk-xxx node server.js');
  process.exit(1);
}

// ---------- 工具函数 ----------
// 逐跳头 (hop-by-hop), 代理转发时必须剔除
const HOP_BY_HOP = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection',
]);

function ts() {
  return new Date().toISOString();
}

function banner(label, detail) {
  return `\n${'='.repeat(16)} ${label} ${detail} ${'='.repeat(16)}`;
}

function idLog(id, msg) {
  console.log(`[#${id}] ${msg}`);
}

// TLS 证书校验失败的错误码, 命中时附加 NODE_EXTRA_CA_CERTS 提示
const TLS_CERT_CODES = new Set([
  'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'CERT_HAS_EXPIRED', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'CERT_UNTRUSTED',
]);

function indent(text, prefix) {
  return text.split('\n').map((l) => prefix + l).join('\n');
}

function maskAuth(value) {
  if (LOG_AUTH) return value;
  const m = /^(Bearer\s+)(.+)$/i.exec(value);
  return m ? m[1] + '***' : '***';
}

function displayHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = k === 'authorization' ? maskAuth(v) : v;
  }
  return out;
}

function truncateText(s) {
  if (s.length <= MAX_LOG_BYTES) return s;
  return s.slice(0, MAX_LOG_BYTES) + `\n… [truncated, ${s.length} bytes total]`;
}

// 尽量把 body 当作 JSON 美化打印, 否则原样输出
function prettyBody(buf) {
  if (!buf.length) return '(empty)';
  const s = buf.toString('utf8');
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

// ---------- 出站代理 (Network Proxy) ----------
// 选择优先级: GATEWAY_PROXY (强制, 忽略旁路) > https_proxy/http_proxy (按目标协议) > all_proxy
// no_proxy/NO_PROXY: 逗号分隔的域名后缀匹配列表, 支持 * 和 .example.com

function hostMatches(host, pattern) {
  const h = host.toLowerCase();
  let p = pattern.toLowerCase();
  if (p.includes(':')) p = p.split(':')[0]; // 忽略 no_proxy 条目里的端口
  if (p === '*') return true;
  if (p.startsWith('.')) return h.endsWith(p) || h === p.slice(1);
  if (p.startsWith('*.')) return h.endsWith(p.slice(1));
  return h === p || h.endsWith('.' + p);
}

function getProxyFor(target) {
  const forced = process.env.GATEWAY_PROXY;
  if (forced) return forced;
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (noProxy.some((p) => hostMatches(target.hostname, p))) return null;
  if (target.protocol === 'https:') {
    return process.env.HTTPS_PROXY || process.env.https_proxy
      || process.env.ALL_PROXY || process.env.all_proxy || null;
  }
  return process.env.HTTP_PROXY || process.env.http_proxy
    || process.env.ALL_PROXY || process.env.all_proxy || null;
}

function proxyAuthHeader(pu) {
  if (pu.username || pu.password) {
    const user = decodeURIComponent(pu.username || '');
    const pass = decodeURIComponent(pu.password || '');
    return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  }
  return null;
}

// 建立到代理的 CONNECT 隧道, 返回一条可复用的裸 socket (支持 https:// 协议的代理)
// 全程打印进度并带超时, 便于定位 "请求发不出去" 的具体卡点
function openTunnel(pu, host, port, auth, id, cb) {
  const proxyPort = pu.port ? Number(pu.port) : (pu.protocol === 'https:' ? 443 : 80);
  const t0 = Date.now();
  let done = false;
  let currentSocket = null;
  const finish = (err, tunnel) => {
    if (done) return;
    done = true;
    if (timer) clearTimeout(timer);
    cb(err, tunnel);
  };
  let timer = setTimeout(() => {
    if (currentSocket) currentSocket.destroy();
    finish(new Error(`proxy 无响应: ${pu.protocol}//${pu.hostname}:${proxyPort} 在 ${CONNECT_TIMEOUT_MS}ms 内未完成 CONNECT (连接被防火墙静默丢弃?)`));
  }, CONNECT_TIMEOUT_MS);

  idLog(id, `[proxy] 解析代理域名 ${pu.hostname} …`);
  dns.lookup(pu.hostname, { verbatim: true }, (dnsErr, ip) => {
    if (dnsErr) {
      idLog(id, `[proxy] DNS 解析失败: ${dnsErr.code} ${dnsErr.message}`);
      return finish(dnsErr);
    }
    idLog(id, `[proxy] ${pu.hostname} → ${ip}, 正在连接 ${pu.protocol}//${ip}:${proxyPort} …`);

    const doConnect = (socket) => {
      idLog(id, `[proxy] 代理 tcp 已连接 (${Date.now() - t0}ms), 发送 CONNECT ${host}:${port}`);
      const req = http.request({
        createConnection: () => socket,
        method: 'CONNECT',
        path: `${host}:${port}`,
        headers: { host: `${host}:${port}`, ...(auth ? { 'proxy-authorization': auth } : {}) },
        setHost: false,
      });
      req.on('connect', (res, tunnel) => {
        idLog(id, `[proxy] CONNECT 响应: ${res.statusCode} ${res.statusMessage || ''} (${Date.now() - t0}ms)`);
        if (res.statusCode !== 200) {
          tunnel.destroy();
          const hint = res.statusCode === 407
            ? ' — 代理需要认证, 请在代理 URL 中带账号: GATEWAY_PROXY=http://user:pass@host:port'
            : '';
          finish(new Error(`proxy CONNECT 被拒绝: ${res.statusCode} for ${host}:${port}${hint}`));
          return;
        }
        tunnel.setTimeout(0); // 解除拨号阶段超时, 避免误杀后续长连接
        finish(null, tunnel);
      });
      req.on('error', (e) => {
        idLog(id, `[proxy] CONNECT 请求出错: ${e.code} ${e.message}`);
        finish(e);
      });
      req.end();
    };

    const onSocketError = (e) => {
      idLog(id, `[proxy] 连接代理失败: ${e.code} ${e.message}`);
      finish(e);
    };

    if (pu.protocol === 'https:') {
      const s = tls.connect({ host: ip, port: proxyPort, servername: pu.hostname });
      currentSocket = s;
      s.once('secureConnect', () => {
        idLog(id, `[proxy] 到代理的 TLS 已建立 (${Date.now() - t0}ms)`);
        doConnect(s);
      });
      s.on('error', onSocketError);
    } else {
      const s = net.connect(proxyPort, ip);
      currentSocket = s;
      s.once('connect', () => doConnect(s));
      s.on('error', onSocketError);
    }
  });
}

// 发起上游请求 (带代理支持), cb(err, clientRequest, via)
// id 用于进度打印; 记录 tcp/TLS 连接耗时, 便于定位出站失败
function requestUpstream(target, opts, proxyUrl, id, cb) {
  let sent = false;
  const send = (err, req, via) => {
    if (sent) return;
    sent = true;
    cb(err, req, via);
  };
  const t0 = Date.now();

  // 监听底层 socket 事件, 打印连接进度 (复用 keep-alive 连接时 'connect' 不会再次触发)
  const trackSocket = (req, label) => {
    req.on('socket', (s) => {
      s.once('connect', () => idLog(id, `[${label}] tcp 已连接 (${Date.now() - t0}ms)`));
      s.once('secureConnect', () => idLog(id, `[${label}] TLS 已建立 (${Date.now() - t0}ms)`));
      s.once('close', (hadError) => {
        if (hadError) idLog(id, `[${label}] socket 异常关闭`);
      });
    });
  };

  if (!proxyUrl) {
    const lib = target.protocol === 'https:' ? https : http;
    const req = lib.request(target, opts);
    trackSocket(req, 'direct');
    idLog(id, `[direct] 直连 ${target.protocol}//${target.host} …`);
    send(null, req, 'direct');
    return;
  }

  let pu;
  try {
    pu = new URL(proxyUrl);
  } catch {
    send(new Error(`invalid proxy url: ${proxyUrl}`));
    return;
  }
  const auth = proxyAuthHeader(pu);
  const proxyPort = pu.port ? Number(pu.port) : (pu.protocol === 'https:' ? 443 : 80);

  if (target.protocol === 'http:') {
    // http 上游: 以 absolute-form 请求发给代理, Host 头指向真实目标
    const lib = pu.protocol === 'https:' ? https : http;
    const req = lib.request({
      ...opts,
      hostname: pu.hostname,
      port: proxyPort,
      path: target.href,
      headers: { ...opts.headers, host: target.host, ...(auth ? { 'proxy-authorization': auth } : {}) },
    });
    trackSocket(req, 'proxy');
    idLog(id, `[proxy] absolute-form 请求发往 ${proxyUrl} …`);
    send(null, req, `proxy ${proxyUrl} (absolute-form)`);
    return;
  }

  // https 上游: CONNECT 隧道 + TLS 握手
  const targetPort = target.port ? Number(target.port) : 443;
  openTunnel(pu, target.hostname, targetPort, auth, id, (err, tunnel) => {
    if (err) return send(err);
    const tlsSocket = tls.connect({ socket: tunnel, servername: target.hostname });
    tlsSocket.on('error', (e) => {
      idLog(id, `[proxy] 到上游的 TLS 握手失败: ${e.code} ${e.message}`);
      send(e);
    });
    tlsSocket.once('secureConnect', () => {
      idLog(id, `[proxy] 到上游的 TLS 已建立 (${Date.now() - t0}ms)`);
      // 注意: 不能传 agent: false — Node 18 会把 false 替换成一个新的默认
      // https.Agent, 该 agent 会忽略 createConnection 并尝试直连上游
      // (绕过 CONNECT 隧道), 在公司网络里直连被静默丢弃, 表现为:
      // TLS 建立后请求永远写不出去, 且 FIRST_BYTE_TIMEOUT 也不触发。
      // 不传 agent (undefined) + 提供 createConnection 时, ClientRequest
      // 会直接使用我们提供的隧道 socket。
      send(null, https.request({
        ...opts,
        hostname: target.hostname,
        port: targetPort,
        path: target.pathname + target.search,
        createConnection: () => tlsSocket,
      }), `proxy ${proxyUrl} (CONNECT)`);
    });
  });
}

// ---------- 日志落盘 (JSONL) ----------
let fileStream = null;
function writeRecord(rec) {
  if (!LOG_FILE) return;
  if (!fileStream) fileStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  const r = { ...rec };
  for (const k of ['request_body', 'response_body']) {
    if (r[k] && r[k].length > MAX_LOG_BYTES) {
      r[k] = r[k].slice(0, MAX_LOG_BYTES) + '…[truncated]';
    }
  }
  fileStream.write(JSON.stringify(r) + '\n');
}

// ---------- SSE 响应聚合 ----------
// 流式响应不再逐帧打印/落盘: 把 SSE 事件折叠成最终的非流式响应对象, 流结束后
// 只记录这一份完整结果 (与客户端最终拿到的响应同构), 避免日志被逐 token 的
// 事件流淹没。支持 Anthropic Messages / OpenAI Responses / Chat Completions。
class SSEResponseAggregator {
  constructor() {
    this.kind = null;      // 'anthropic' | 'responses' | 'chat'
    this.eventName = '';
    this.dataLines = [];
    this.events = 0;
    this.bytes = 0;
    this.done = false;
    this.error = null;
    this.firstData = '';
    this.lastData = '';
    this.message = null;   // anthropic: 完整 Message
    this.response = null;  // responses: response.completed 里的完整 Response
    this.chat = null;      // chat: 聚合后的完整 ChatCompletion
  }

  // 输入一行原始 SSE 文本 (转换模式下是出站帧, 透传模式下是上游原文)
  pushLine(line) {
    this.bytes += Buffer.byteLength(line, 'utf8') + 1;
    if (line === '') {
      this.dispatch();
      return;
    }
    if (line.startsWith(':')) return; // SSE 注释 / keep-alive
    if (line.startsWith('event:')) {
      this.eventName = line.slice(6).trim();
      return;
    }
    if (!line.startsWith('data:')) return; // id: / retry: 忽略
    let data = line.slice(5);
    if (data.startsWith(' ')) data = data.slice(1);
    this.dataLines.push(data);
  }

  // 一个事件以空行结束: 解析 data: 载荷并折叠进最终响应
  dispatch() {
    this.eventName = '';
    if (this.dataLines.length === 0) return;
    const data = this.dataLines.join('\n');
    this.dataLines = [];
    this.events += 1;
    if (this.firstData === '') this.firstData = data;
    this.lastData = data;
    const trimmed = data.trim();
    if (trimmed === '[DONE]') {
      this.done = true;
      return;
    }
    let obj;
    try { obj = JSON.parse(trimmed); } catch { return; }
    if (obj === null || typeof obj !== 'object') return;
    if (obj.error !== undefined && !Array.isArray(obj.choices)) {
      this.error = obj.error;
      this.done = true;
      return;
    }
    const type = typeof obj.type === 'string' ? obj.type : '';
    if (type === 'message_start' || type.startsWith('content_block_')
        || type === 'message_delta' || type === 'message_stop') {
      this.kind = 'anthropic';
      this.onAnthropic(obj, type);
    } else if (type.startsWith('response.')) {
      this.kind = 'responses';
      this.onResponses(obj, type);
    } else if (Array.isArray(obj.choices)
        || String(obj.object || '').startsWith('chat.completion')) {
      this.kind = 'chat';
      this.onChat(obj);
    } else if (type === 'error') {
      this.error = obj.error || obj;
      this.done = true;
    }
  }

  onAnthropic(obj, type) {
    switch (type) {
      case 'message_start': {
        const msg = obj.message && typeof obj.message === 'object' ? obj.message : {};
        this.message = {
          type: 'message', role: 'assistant',
          ...msg,
          content: Array.isArray(msg.content) ? msg.content.slice() : []
        };
        break;
      }
      case 'content_block_start': {
        if (!this.message) this.message = { type: 'message', role: 'assistant', content: [] };
        if (!Array.isArray(this.message.content)) this.message.content = [];
        const block = { ...(obj.content_block || {}) };
        if (block.type === 'tool_use') block._partialJson = '';
        const index = typeof obj.index === 'number' ? obj.index : this.message.content.length;
        this.message.content[index] = block;
        break;
      }
      case 'content_block_delta': {
        if (!this.message) this.message = { type: 'message', role: 'assistant', content: [] };
        if (!Array.isArray(this.message.content)) this.message.content = [];
        const d = obj.delta || {};
        const last = this.message.content.length - 1;
        const index = typeof obj.index === 'number' ? obj.index : (last >= 0 ? last : 0);
        let block = this.message.content[index];
        if (!block) {
          // 防御: 少数上游省略 content_block_start/index, 按 delta 类型补一个块
          block = d.type === 'thinking_delta' ? { type: 'thinking', thinking: '' }
            : d.type === 'input_json_delta' ? { type: 'tool_use', id: '', name: '', input: {}, _partialJson: '' }
            : { type: 'text', text: '' };
          this.message.content[index] = block;
        }
        if (d.type === 'text_delta') block.text = (block.text || '') + (d.text || '');
        else if (d.type === 'thinking_delta') block.thinking = (block.thinking || '') + (d.thinking || '');
        else if (d.type === 'signature_delta') block.signature = d.signature;
        else if (d.type === 'input_json_delta') block._partialJson = (block._partialJson || '') + (d.partial_json || '');
        else if (d.type === 'citations_delta') (block.citations = block.citations || []).push(d.citation);
        break;
      }
      case 'content_block_stop': {
        const content = this.message && this.message.content;
        if (!Array.isArray(content)) break;
        const index = typeof obj.index === 'number' ? obj.index : content.length - 1;
        const block = content[index];
        if (block && block.type === 'tool_use') {
          if (block._partialJson) {
            try { block.input = JSON.parse(block._partialJson); }
            catch { block.input = block._partialJson; }
          } else if (block.input === undefined) {
            block.input = {};
          }
          delete block._partialJson;
        }
        break;
      }
      case 'message_delta': {
        if (!this.message) break;
        const d = obj.delta || {};
        if (d.stop_reason !== undefined) this.message.stop_reason = d.stop_reason;
        if (d.stop_sequence !== undefined) this.message.stop_sequence = d.stop_sequence;
        if (obj.usage) this.message.usage = { ...(this.message.usage || {}), ...obj.usage };
        break;
      }
      case 'message_stop':
        this.done = true;
        break;
      default:
        break;
    }
  }

  onResponses(obj, type) {
    if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
      if (obj.response && typeof obj.response === 'object') this.response = obj.response;
      if (type === 'response.failed') {
        this.error = (obj.response && obj.response.error) || { message: 'response failed' };
      }
      this.done = true;
    } else if (type === 'error') {
      this.error = obj.error || obj;
      this.done = true;
    }
  }

  onChat(obj) {
    if (!this.chat) {
      this.chat = {
        id: obj.id || '',
        object: 'chat.completion',
        created: obj.created || 0,
        model: obj.model || '',
        choices: []
      };
    }
    if (obj.id) this.chat.id = obj.id;
    if (obj.model) this.chat.model = obj.model;
    if (typeof obj.created === 'number') this.chat.created = obj.created;
    if (obj.usage) this.chat.usage = obj.usage;

    const choice = (obj.choices || [])[0];
    if (!choice) return;
    const index = typeof choice.index === 'number' ? choice.index : 0;
    let state = this.chat.choices.find((c) => c.index === index);
    if (!state) {
      state = { index, message: { role: 'assistant', content: '' }, finish_reason: null };
      this.chat.choices.push(state);
    }
    const delta = choice.delta || choice.message || {};
    if (delta.role) state.message.role = delta.role;
    if (typeof delta.content === 'string') state.message.content += delta.content;
    // reasoning_content > reasoning > reasoning_details (与 convert.js 一致)
    const reasoning = convert.extractReasoningFieldText(delta);
    if (reasoning) {
      state.message.reasoning_content = (state.message.reasoning_content || '') + reasoning;
    }
    if (Array.isArray(delta.tool_calls)) {
      state.message.tool_calls = state.message.tool_calls || [];
      for (const tc of delta.tool_calls) {
        const tcIndex = typeof tc.index === 'number' ? tc.index : state.message.tool_calls.length;
        let call = state.message.tool_calls[tcIndex];
        if (!call) {
          call = { id: '', type: 'function', function: { name: '', arguments: '' } };
          state.message.tool_calls[tcIndex] = call;
        }
        if (tc.id) call.id = tc.id;
        if (tc.type) call.type = tc.type;
        const fn = tc.function || {};
        if (typeof fn.name === 'string' && fn.name !== '') call.function.name += fn.name;
        if (typeof fn.arguments === 'string') call.function.arguments += fn.arguments;
      }
    }
    if (choice.finish_reason !== undefined) state.finish_reason = choice.finish_reason;
  }

  // 折叠结果; 可重复调用 (正常结束与客户端中断共用)
  result() {
    this.dispatch(); // 收尾没有以空行结束的最后一个事件

    if (this.kind === 'responses' && this.response) return this.response;
    if (this.kind === 'anthropic' && this.message) {
      return this.error
        ? { type: 'error', error: this.error, partial_message: this.message }
        : this.message;
    }
    if (this.kind === 'chat' && this.chat) {
      return this.error
        ? { type: 'error', error: this.error, partial_response: this.chat }
        : this.chat;
    }
    if (this.error) return { type: 'error', error: this.error, sse_events: this.events };
    // 无法识别的流只给摘要, 不保存完整 SSE 原文
    const preview = (s) => (s.length > 2000 ? s.slice(0, 2000) + '…' : s);
    return {
      type: 'sse_summary',
      sse_events: this.events,
      sse_bytes: this.bytes,
      done: this.done,
      ...(this.firstData !== '' ? { first_data: preview(this.firstData) } : {}),
      ...(this.lastData !== '' ? { last_data: preview(this.lastData) } : {})
    };
  }
}

// 流结束后打印一次完整响应, 并把同一份 JSON 作为 record.response_body 落盘
function logCompleteResponse(id, agg, upstreamSseBytes, result) {
  const payload = result === undefined ? agg.result() : result;
  const body = JSON.stringify(payload);
  console.log(`[#${id}] response body (SSE → complete response, ${Buffer.byteLength(body)} bytes`
    + (upstreamSseBytes !== undefined ? `; 上游 SSE ${upstreamSseBytes} bytes` : '') + '):');
  console.log(indent(truncateText(JSON.stringify(payload, null, 2)), `[#${id}]   `));
  return body;
}

// 上游返回"没有可见输出"的响应时统一告警并落盘诊断字段。
// 最常见的是 reasoning-only: reasoning 有内容、content 为空 (思考型模型把整段答案
// 写进 reasoning 通道后直接 stop, 参见 BerriAI/litellm#38199)。
// 返回 true 表示这是一次 reasoning-only。
function reportNoVisibleOutput(id, record, diag, opts = {}) {
  if (!diag || diag.has_visible_output) return false;
  const reasoningChars = diag.reasoning_chars || 0;
  const reasoningBlocks = diag.reasoning_blocks || 0;
  const reasoningOnly = reasoningChars > 0 || reasoningBlocks > 0;
  const contentChars = diag.content_chars || 0;
  const toolCalls = diag.tool_calls || 0;
  const label = reasoningOnly ? 'reasoning-only' : 'empty-response';
  let outcome = opts.outcome || '原样透传 (客户端会看到空正文)';
  if (!opts.outcome) {
    const mode = opts.emptyMode;
    if (opts.applied === false) {
      outcome = mode === 'pass'
        ? '原样透传 (客户端会看到 Done 但没有输出)'
        : `未兜底 (finish_reason=${diag.finish_reason || '?'})`;
    } else if (mode === 'auto' && reasoningOnly) {
      outcome = '已把 reasoning 当正文回吐';
    } else if (mode === 'error' && opts.stream) {
      outcome = '已发 error 事件中止本轮';
    } else {
      outcome = '已补说明文本';
    }
  }
  console.log(`[#${id}] [WARN] ${label}: 上游没有可见输出`
    + ` (finish=${diag.finish_reason || '?'}, reasoning=${reasoningChars} chars`
    + (reasoningBlocks > 1 ? `/${reasoningBlocks} blocks` : '')
    + `, content=${contentChars} chars, tool_calls=${toolCalls}`
    + (opts.model ? `, 模型=${opts.model}` : '')
    + (opts.emptyMode ? `, EMPTY_RESPONSE_MODE=${opts.emptyMode}` : '')
    + `) — ${outcome}`);
  record.empty_response = true;
  record.reasoning_only = reasoningOnly;
  record.reasoning_chars = reasoningChars;
  record.content_chars = contentChars;
  record.tool_calls = toolCalls;
  if (diag.finish_reason) record.upstream_finish_reason = diag.finish_reason;
  if (opts.emptyMode) record.empty_response_mode = opts.emptyMode;
  if (opts.salvaged !== undefined) record.empty_response_salvaged = opts.salvaged;
  return reasoningOnly;
}

// ---------- 转发逻辑 ----------
let reqCounter = 0;

function handleRequest(req, res, body, id) {
  const startedAt = Date.now();

  // 构造出站请求头: 复制入站头, 剔除逐跳头/host, 强制明文(去掉 accept-encoding 以便记录), 重写 auth
  const outHeaders = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (HOP_BY_HOP.has(k)) continue;
    if (k === 'host' || k === 'accept-encoding' || k === 'authorization') continue;
    outHeaders[k] = v;
  }
  outHeaders.authorization = `Bearer ${UPSTREAM_TOKEN}`;
  if (body.length) outHeaders['content-length'] = String(body.length);

  // 客户端 path 归一化: 连续重复的 /v1 段折叠为一个。
  // 例: ANTHROPIC_BASE_URL 误带 /v1 的 Claude Code 会发 POST /v1/v1/messages?beta=true,
  // 不归一化既匹配不上协议转换 (精确匹配 /v1/messages), 透传还会拼出三 /v1 的 404。
  // 折叠只作用于 origin-form; 绝对 URL (HTTP 代理转发的 absolute-form) 保持原样。
  const clientUrlObj = new URL(req.url, 'http://local');
  const collapsedPathname = collapseV1(clientUrlObj.pathname);
  const clientUrl = (collapsedPathname && !req.url.startsWith('http'))
    ? collapsedPathname + clientUrlObj.search
    : req.url;
  if (collapsedPathname && clientUrl !== req.url) {
    console.log(`[#${id}] path normalize  : ${req.url} → ${clientUrl}`);
  }

  // 出站 URL: 保留 upstream 的路径前缀 + 客户端原始 path/query
  let target;
  try {
    target = req.url.startsWith('http') ? new URL(req.url) : new URL(UPSTREAM_URL + clientUrl);
  } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'invalid url: ' + e.message }));
    return;
  }
  // 拼接 UPSTREAM_URL 后可能再次出现连续 /v1 (UPSTREAM_URL 本身以 /v1 结尾时), 同样折叠
  const targetCollapsed = collapseV1(target.pathname);
  if (targetCollapsed) {
    console.log(`[#${id}] upstream normalize: ${target.pathname + target.search} → ${targetCollapsed + target.search}`);
    target.pathname = targetCollapsed;
  }

  // ---- 协议转换: Anthropic Messages / OpenAI Responses -> Chat Completions ----
  // convertKind: null (透传) | 'anthropic' | 'responses'
  let convertKind = null;
  let outBody = body;
  let toolContext = null;
  let requestStream = false;
  const pathname = new URL(clientUrl, 'http://local').pathname;
  if (CONVERT_ANTHROPIC && req.method === 'POST' && pathname === '/v1/messages') {
    convertKind = 'anthropic';
  } else if (CONVERT_RESPONSES && req.method === 'POST' && pathname === '/v1/responses') {
    convertKind = 'responses';
  }

  let inlineSystemCount = 0;
  let inlineSystemNormalized = false;
  if (convertKind) {
    let parsed;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch (e) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid json body: ' + e.message }));
      return;
    }
    requestStream = parsed.stream === true;
    try {
      let converted;
      if (convertKind === 'anthropic') {
        inlineSystemCount = countInlineSystemMessages(parsed);
        if (inlineSystemCount > 0) {
          inlineSystemNormalized = NORMALIZE_INLINE_SYSTEM;
          console.log(`[#${id}] messages[] 内含 ${inlineSystemCount} 条 role=system → `
            + (NORMALIZE_INLINE_SYSTEM ? '全部按 user 发送 (NORMALIZE_INLINE_SYSTEM=0 可关闭)' : '按原样发送'));
        }
        converted = convert.anthropicToOpenAI(parsed, { normalizeInlineSystem: NORMALIZE_INLINE_SYSTEM });
      } else {
        toolContext = new convert.ToolContext();
        toolContext.buildFromRequest(parsed);
        converted = convert.responsesToChatCompletions(parsed, { attachReasoning: ATTACH_REASONING });
      }
      outBody = Buffer.from(JSON.stringify(converted));
    } catch (e) {
      console.error(`[#${id}] convert request failed: ${e.message}`);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'convert request failed: ' + e.message }));
      return;
    }
    target = chatCompletionsTarget();
    outHeaders['content-type'] = 'application/json';
    outHeaders['content-length'] = String(outBody.length);
    if (convertKind === 'anthropic') {
      // chat 上游不认识 Anthropic 专属头, 剥掉避免严格网关 400
      delete outHeaders['anthropic-version'];
      delete outHeaders['anthropic-beta'];
      delete outHeaders['x-api-key'];
    }
    console.log(`[#${id}] protocol convert : ${convertKind} -> chat/completions (${outBody.length} bytes)`);
    console.log(indent(truncateText(JSON.stringify(JSON.parse(outBody.toString('utf8')), null, 2)), `[#${id}]   `));
  }

  // ---- 打印请求 (入站 + 出站) ----
  console.log(banner(`REQ #${id} ${ts()}`, ''));
  console.log(`[#${id}] client → gateway : ${req.method} ${req.url}`);
  console.log(`[#${id}] request headers  : ${JSON.stringify(displayHeaders(req.headers), null, 2)}`);
  console.log(`[#${id}] request body (${body.length} bytes):`);
  console.log(indent(truncateText(prettyBody(body)), `[#${id}]   `));
  console.log(`[#${id}] gateway → upstream: ${req.method} ${target.href}`);
  console.log(`[#${id}] outbound headers : ${JSON.stringify(displayHeaders(outHeaders), null, 2)}`);

  // 出站代理选择 (GATEWAY_PROXY > https_proxy/http_proxy/all_proxy + no_proxy 旁路)
  const proxyUrl = getProxyFor(target);
  console.log(`[#${id}] proxy            : ${proxyUrl || '(direct)'}`);

  const record = {
    ts: ts(),
    id,
    method: req.method,
    path: req.url,
    upstream_url: target.href,
    request_headers: req.headers,
    outbound_headers: outHeaders,
    request_body: outBody.toString('utf8'),
  };
  if (inlineSystemCount > 0) record.inline_system_messages = inlineSystemCount;
  if (inlineSystemNormalized) record.inline_system_normalized = true;
  if (convertKind) record.request_body_original = body.toString('utf8');
  if (convertKind) record.protocol_convert = `${convertKind} -> chat/completions`;

  // 每个请求只落一条记录: 正常结束/中途断开/上游错误共用此闸门
  let recordWritten = false;
  const saveRecord = () => {
    if (recordWritten) return;
    recordWritten = true;
    writeRecord(record);
  };

  // 当前活跃的上游请求对象 (零字节空响应透明重试时会换新 request, 客户端断开时销毁它)
  let activeUpReq = null;

  requestUpstream(target, { method: req.method, headers: outHeaders }, proxyUrl, id, (err, upReq, via) => {
    if (err) {
      console.log(banner(`RESP #${id}`, `<- UPSTREAM ERROR after ${Date.now() - startedAt} ms`));
      console.error(`[#${id}] ${err.message}`);
      if (err && err.code && TLS_CERT_CODES.has(err.code)) {
        console.error(`[#${id}] hint: TLS 证书校验失败 — 若是公司 MITM 代理, 设置 NODE_EXTRA_CA_CERTS=<ca.pem>; 仅调试可用 NODE_TLS_REJECT_UNAUTHORIZED=0`);
      }
      record.proxy = 'error';
      record.error = err.message;
      saveRecord();
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream error: ' + err.message }));
      } else {
        res.end();
      }
      return;
    }
    record.proxy = via;
    activeUpReq = upReq;

    // 已收到的响应分片/帧, 供客户端断开时补写记录
    let upstreamSseBytes = 0;   // convert 分支: 上游原始 SSE 字节数 (只计数, 不保留原文)
    let convertedFrames = 0;    // convert 分支: 已写给客户端的帧数 (透明重试判据)
    const bodyParts = [];       // 直通/非流式分支: 响应分片
    let respAggregator = null;  // SSE 分支: 把事件流折叠成完整响应

    // 首字节超时: 只约束"响应到达前", 响应开始后解除 (LLM 流式响应可能持续很久)
    let responseStarted = false;
    upReq.setTimeout(FIRST_BYTE_TIMEOUT_MS, () => {
      if (!responseStarted) {
        upReq.destroy(new Error(`upstream 在 ${FIRST_BYTE_TIMEOUT_MS}ms 内没有响应 (请求可能未发出或被静默丢弃)`));
      }
    });
    upReq.on('finish', () => {
      idLog(id, `outbound request 已写出 (${body.length} bytes, +${Date.now() - startedAt}ms) — 等待上游响应`);
    });

    // 建立隧道期间客户端可能已断开
    if (res.destroyed || res.writableEnded) {
      upReq.destroy();
      console.log(`[#${id}] client disconnected before upstream request was sent`);
      return;
    }

    upReq.on('response', (upRes) => {
      const durMs = Date.now() - startedAt;
      responseStarted = true;
      upReq.setTimeout(0); // 流式阶段不再计时, 避免误杀慢流
      const respHeaders = {};
      for (const [k, v] of Object.entries(upRes.headers)) {
        if (!HOP_BY_HOP.has(k)) respHeaders[k] = v;
      }
      const contentType = String(upRes.headers['content-type'] || '');
      const isSSE = contentType.includes('text/event-stream');

      console.log(banner(`RESP #${id}`, `<- ${upRes.statusCode} ${upRes.statusMessage || ''} in ${durMs} ms`));
      console.log(`[#${id}] response headers : ${JSON.stringify(displayHeaders(respHeaders), null, 2)}`);

      record.response_status = upRes.statusCode;
      record.response_headers = respHeaders;
      record.duration_ms = durMs;

      // 终态帧 (response.completed / message_stop 等) 已写出后客户端关闭连接,
      // 属正常收尾竞态, 不再告警; 未到终态的中途断开才记为 abort
      let streamCompleted = false;
      const TERMINAL_EVENTS = ['event: response.completed', 'event: response.failed', 'event: message_stop', 'event: error'];
      const isTerminalFrame = (frame) => TERMINAL_EVENTS.some((ev) => frame.startsWith(ev));

      // 客户端中途断开 -> 终止上游请求
      res.on('close', () => {
        if (!res.writableEnded) {
          if (activeUpReq) activeUpReq.destroy();
          if (!streamCompleted) {
            console.log(`[#${id}] client disconnected, upstream request aborted`);
            record.aborted = true;
          }
          // upRes 'end' 不会再触发: 就地补写记录, 避免丢 usage 账目
          if (upstreamSseBytes) record.upstream_sse_bytes = upstreamSseBytes;
          if (respAggregator) {
            record.response_body = logCompleteResponse(id, respAggregator);
            record.sse_events = respAggregator.events;
            record.sse_bytes = respAggregator.bytes;
          } else if (bodyParts.length) {
            record.response_body = Buffer.concat(bodyParts).toString('utf8');
          }
          saveRecord();
        }
      });

      if (convertKind) {
        // ---- 转换模式: 上游 chat 响应按客户端协议重新组装 ----
        if (isSSE) {
          const outHeaders2 = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' };
          for (const [k, v] of Object.entries(respHeaders)) {
            if (!['content-type', 'content-length', 'transfer-encoding'].includes(k)) outHeaders2[k] = v;
          }
          res.writeHead(upRes.statusCode, outHeaders2);

          // 透明重试: 上游「完全空」响应 (零 delta 就 finish_reason=stop, 或零字节断流)
          // 且客户端还没收到任何帧时, 丢弃本次转换结果重发上游请求。message_start /
          // response.created 延迟到第一个真实 delta 才发 (见 convert.js), 所以空响应在
          // 客户端眼里是零字节, 重试完全透明; 重试次数用尽后走原有兜底策略。
          let attempt = 0;

          // 空响应 -> 重发同一个上游请求 (首次尝试复用外层已发起的请求, 这里只负责重试)
          const startRetry = () => {
            requestUpstream(target, { method: req.method, headers: outHeaders }, proxyUrl, id, (err, upReq3, via) => {
              if (err) {
                console.log(banner(`RESP #${id}`, `<- UPSTREAM ERROR after ${Date.now() - startedAt} ms`));
                console.error(`[#${id}] ${err.message}`);
                if (err && err.code && TLS_CERT_CODES.has(err.code)) {
                  console.error(`[#${id}] hint: TLS 证书校验失败 — 若是公司 MITM 代理, 设置 NODE_EXTRA_CA_CERTS=<ca.pem>; 仅调试可用 NODE_TLS_REJECT_UNAUTHORIZED=0`);
                }
                record.proxy = 'error';
                record.error = err.message;
                saveRecord();
                res.end(); // SSE 头已发出, 只能中断流 (客户端会看到不完整响应)
                return;
              }
              record.proxy = via;
              activeUpReq = upReq3;
              let retryResponseStarted = false;
              upReq3.setTimeout(FIRST_BYTE_TIMEOUT_MS, () => {
                if (!retryResponseStarted) {
                  upReq3.destroy(new Error(`upstream 在 ${FIRST_BYTE_TIMEOUT_MS}ms 内没有响应 (请求可能未发出或被静默丢弃)`));
                }
              });
              upReq3.on('finish', () => {
                idLog(id, `outbound request 已写出 (重试, ${body.length} bytes, +${Date.now() - startedAt}ms) — 等待上游响应`);
              });
              if (res.destroyed || res.writableEnded) {
                upReq3.destroy();
                console.log(`[#${id}] client disconnected before upstream retry was sent`);
                return;
              }
              upReq3.on('response', (upRes3) => {
                retryResponseStarted = true;
                upReq3.setTimeout(0);
                const durMs = Date.now() - startedAt;
                const respHeaders3 = {};
                for (const [k, v] of Object.entries(upRes3.headers)) {
                  if (!HOP_BY_HOP.has(k)) respHeaders3[k] = v;
                }
                console.log(banner(`RESP #${id}`, `<- ${upRes3.statusCode} ${upRes3.statusMessage || ''} in ${durMs} ms`));
                console.log(`[#${id}] response headers : ${JSON.stringify(displayHeaders(respHeaders3), null, 2)}`);
                record.response_status = upRes3.statusCode;
                record.response_headers = respHeaders3;
                record.duration_ms = durMs;
                handleSSEResponse(upReq3, upRes3);
              });

              if (outBody.length) upReq3.write(outBody);
              upReq3.end();
            });
          };

          // 把一次上游 SSE 响应转换后写给客户端; 结束时判定是否需要透明重试
          const handleSSEResponse = (upReqX, upResX) => {
            const streamConv = convertKind === 'anthropic'
              ? new convert.AnthropicStreamConverter({ emptyResponseMode: EMPTY_RESPONSE_MODE })
              : new convert.ResponsesStreamConverter(toolContext, {
                  attachReasoning: ATTACH_REASONING,
                  emptyResponseMode: EMPTY_RESPONSE_MODE
                });
            const sseAgg = new SSEResponseAggregator();
            respAggregator = sseAgg;
            const writeFrames = (frames) => {
              for (const frame of frames) {
                convertedFrames += 1;
                // 只喂聚合器, 不逐帧打印; 空行也要保留 (它是事件分隔符)
                for (const fline of frame.split('\n')) sseAgg.pushLine(fline);
                if (isTerminalFrame(frame)) streamCompleted = true;
                if (res.writableEnded) return;
                if (!res.write(frame)) {
                  upResX.pause();
                  res.once('drain', () => upResX.resume());
                }
              }
            };
            let lineBuf = '';
            const feedLine = (line) => {
              // 转换器只消费 data 行, event:/注释行忽略
              if (!line.startsWith('data:')) return;
              const data = line.slice(5).trimStart();
              writeFrames(streamConv.push(data));
            };
            upResX.on('data', (chunk) => {
              upstreamSseBytes += chunk.length;
              lineBuf += chunk.toString('utf8');
              let idx;
              while ((idx = lineBuf.indexOf('\n')) !== -1) {
                const line = lineBuf.slice(0, idx).replace(/\r$/, '');
                lineBuf = lineBuf.slice(idx + 1);
                feedLine(line);
              }
            });
            upResX.on('end', () => {
              if (lineBuf) feedLine(lineBuf);
              const flushFrames = streamConv.flush();
              // 透明重试判据: 客户端零字节已写出 + 上游一个真实 delta 都没吐 +
              // 以 stop 收尾或直接断流。content_filter / tool_calls / 已出思考等不重试。
              const finish = streamConv.upstreamFinishReason;
              if (convertedFrames === 0
                  && !streamConv.sawRealDelta
                  && (finish === 'stop' || finish === null)
                  && attempt < EMPTY_RESPONSE_RETRIES
                  && !res.writableEnded && !res.destroyed) {
                attempt += 1;
                record.upstream_retries = attempt;
                console.log(`[#${id}] [WARN] 上游空响应 (finish_reason=${finish || '断流'},`
                  + ` 客户端零字节已写出) — 透明重试 ${attempt}/${EMPTY_RESPONSE_RETRIES}`);
                return startRetry();
              }
              writeFrames(flushFrames);
              // 记录上游原始 finish_reason: 只有它才能区分 "模型自己 stop" 与
              // "content_filter 拦截" (后者在 Anthropic 侧同样表现为空响应)
              if (streamConv.upstreamFinishReason) {
                console.log(`[#${id}] upstream finish_reason: ${streamConv.upstreamFinishReason}`);
                record.upstream_finish_reason = streamConv.upstreamFinishReason;
              }
              // 追踪 reasoning-only / 空响应: 只要上游没有产出可见输出就记一条,
              // 包括 finish_reason=length 等没走空响应兜底的情形。
              const upstreamDiag = streamConv.diagnostics();
              if (upstreamDiag && !upstreamDiag.has_visible_output) {
                const reasoningOnly = (upstreamDiag.reasoning_chars || 0) > 0
                  || (upstreamDiag.reasoning_blocks || 0) > 0;
                let outcome;
                if (streamConv.emptyResponseDetected) {
                  if (EMPTY_RESPONSE_MODE === 'pass') {
                    outcome = '原样透传 (客户端会看到 Done 但没有输出)';
                  } else if (EMPTY_RESPONSE_MODE === 'error') {
                    outcome = '已发 error 事件中止本轮';
                  } else if (EMPTY_RESPONSE_MODE === 'auto' && reasoningOnly) {
                    outcome = '已把 reasoning 当正文回吐';
                  } else {
                    outcome = '已补说明文本';
                  }
                } else if (upstreamDiag.finish_reason === 'length') {
                  outcome = '未兜底 (finish_reason=length, 客户端会看到截断)';
                } else if (upstreamDiag.finish_reason === null) {
                  outcome = '上游断流, 已发 error 事件';
                } else {
                  outcome = `未兜底 (finish_reason=${upstreamDiag.finish_reason})`;
                }
                if (attempt > 0) outcome += `, 已透明重试 ${attempt} 次`;
                reportNoVisibleOutput(id, record, upstreamDiag, {
                  emptyMode: EMPTY_RESPONSE_MODE,
                  stream: true,
                  model: streamConv.currentModel || streamConv.model || '',
                  applied: streamConv.emptyResponseDetected && EMPTY_RESPONSE_MODE !== 'pass',
                  salvaged: streamConv.emptyResponseSalvagedReasoning,
                  outcome
                });
                if (streamConv.emptyResponseDetected) {
                  for (const l of outboundTailLines(outBody)) {
                    console.log(`[#${id}]        出站末段 ${l}`);
                  }
                }
              }
              if (upstreamSseBytes) record.upstream_sse_bytes = upstreamSseBytes;
              record.response_body = logCompleteResponse(id, sseAgg, upstreamSseBytes);
              record.sse_events = sseAgg.events;
              record.sse_bytes = sseAgg.bytes;
              saveRecord();
              res.end();
            });
          };
          handleSSEResponse(upReq, upRes);
        } else {
          // 非流式 (含上游 JSON 错误): 攒完整 body, 转换后一次性回给客户端
          upRes.on('data', (chunk) => bodyParts.push(chunk));
          upRes.on('end', () => {
            const raw = Buffer.concat(bodyParts);
            let out = raw;
            try {
              const parsed = JSON.parse(raw.toString('utf8'));
              const upstreamDiag = upRes.statusCode >= 400
                ? null : convert.diagnoseResponse(parsed);
              const converted = upRes.statusCode >= 400
                ? (convertKind === 'anthropic'
                    ? convert.chatErrorToAnthropicError(parsed)
                    : convert.chatErrorToResponseError(parsed))
                : (convertKind === 'anthropic'
                ? convert.openaiToAnthropic(parsed, { emptyResponseMode: EMPTY_RESPONSE_MODE })
                : convert.chatCompletionToResponse(parsed, toolContext, {
                    emptyResponseMode: EMPTY_RESPONSE_MODE
                  }));
              out = Buffer.from(JSON.stringify(converted));
              if (upstreamDiag && !upstreamDiag.has_visible_output) {
                const convertedDiag = convert.diagnoseResponse(converted);
                const applied = !!(convertedDiag && convertedDiag.has_visible_output);
                const reasoningOnly = (upstreamDiag.reasoning_chars || 0) > 0
                  || (upstreamDiag.reasoning_blocks || 0) > 0;
                let outcome;
                if (!applied) {
                  outcome = EMPTY_RESPONSE_MODE === 'pass'
                    ? '原样透传 (客户端会看到空正文)'
                    : `未兜底 (finish_reason=${upstreamDiag.finish_reason || '?'})`;
                } else if (EMPTY_RESPONSE_MODE === 'auto' && reasoningOnly) {
                  outcome = '已把 reasoning 当正文回吐';
                } else {
                  outcome = '已补说明文本 (非流式)';
                }
                reportNoVisibleOutput(id, record, upstreamDiag, {
                  emptyMode: EMPTY_RESPONSE_MODE,
                  stream: false,
                  model: parsed.model || '',
                  applied,
                  salvaged: applied && EMPTY_RESPONSE_MODE === 'auto' && reasoningOnly,
                  outcome
                });
              }
            } catch (e) {
              console.error(`[#${id}] convert response failed (${e.message}), 原样透传`);
              out = raw;
            }
            console.log(`[#${id}] converted response body (${out.length} bytes):`);
            console.log(indent(truncateText(prettyBody(out)), `[#${id}]   `));
            record.response_body_upstream = raw.toString('utf8');
            record.response_body = out.toString('utf8');
            saveRecord();
            res.writeHead(upRes.statusCode, { 'content-type': 'application/json' });
            res.end(out);
          });
        }
      } else if (isSSE) {
        // 流式: 边转发边聚合, 流结束后只记录一次完整响应 (不逐帧打印)
        res.writeHead(upRes.statusCode, respHeaders);
        const sseAgg = new SSEResponseAggregator();
        respAggregator = sseAgg;
        let lineBuf = '';
        upRes.on('data', (chunk) => {
          lineBuf += chunk.toString('utf8');
          let idx;
          while ((idx = lineBuf.indexOf('\n')) !== -1) {
            const line = lineBuf.slice(0, idx).replace(/\r$/, '');
            lineBuf = lineBuf.slice(idx + 1);
            if (line === 'data: [DONE]' || line.startsWith('event: message_stop') || line.startsWith('event: error')) {
              streamCompleted = true;
            }
            sseAgg.pushLine(line);
          }
          // 背压: 客户端写不动时暂停上游
          if (!res.write(chunk)) {
            upRes.pause();
            res.once('drain', () => upRes.resume());
          }
        });
        upRes.on('end', () => {
          if (lineBuf) sseAgg.pushLine(lineBuf);
          const aggResult = sseAgg.result();
          const diag = convert.diagnoseResponse(aggResult);
          if (diag && !diag.has_visible_output) {
            reportNoVisibleOutput(id, record, diag, {
              model: aggResult.model || '',
              outcome: diag.finish_reason === 'length' || diag.finish_reason === 'incomplete'
                ? '原样透传 (上游截断)'
                : '原样透传 (客户端会看到空正文)'
            });
          }
          record.response_body = logCompleteResponse(id, sseAgg, undefined, aggResult);
          record.sse_events = sseAgg.events;
          record.sse_bytes = sseAgg.bytes;
          saveRecord();
          res.end();
        });
      } else {
        // 非流式: 攒完整 body, 打印后一次性回给客户端
        const bodyParts = [];
        upRes.on('data', (chunk) => bodyParts.push(chunk));
        upRes.on('end', () => {
          const respBody = Buffer.concat(bodyParts);
          // 追踪 reasoning-only / 空正文 (纯透传, 不改变响应本身)
          try {
            const parsed = JSON.parse(respBody.toString('utf8'));
            const diag = convert.diagnoseResponse(parsed);
            if (diag && !diag.has_visible_output) {
              reportNoVisibleOutput(id, record, diag, {
                model: parsed.model || '',
                outcome: '原样透传 (客户端会看到空正文)'
              });
            }
          } catch { /* 非 JSON 响应, 忽略 */ }
          console.log(`[#${id}] response body (${respBody.length} bytes):`);
          console.log(indent(truncateText(prettyBody(respBody)), `[#${id}]   `));
          record.response_body = respBody.toString('utf8');
          saveRecord();
          res.writeHead(upRes.statusCode, respHeaders);
          res.end(respBody);
        });
      }
    });

    upReq.on('error', (err) => {
      console.log(banner(`RESP #${id}`, `<- UPSTREAM ERROR after ${Date.now() - startedAt} ms`));
      console.error(`[#${id}] ${err.message}`);
      if (err && err.code && TLS_CERT_CODES.has(err.code)) {
        console.error(`[#${id}] hint: TLS 证书校验失败 — 若是公司 MITM 代理, 设置 NODE_EXTRA_CA_CERTS=<ca.pem>; 仅调试可用 NODE_TLS_REJECT_UNAUTHORIZED=0`);
      }
      record.error = err.message;
      saveRecord();
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'upstream error: ' + err.message }));
      } else {
        res.end();
      }
    });

    if (outBody.length) upReq.write(outBody);
    upReq.end();
  });
}

// ---------- HTTP server ----------
const server = http.createServer((req, res) => {
  if (req.method === 'GET' && (req.url === '/healthz' || req.url === '/health')) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok\n');
    return;
  }

  const chunks = [];
  let total = 0;
  req.on('data', (c) => {
    chunks.push(c);
    total += c.length;
  });
  req.on('error', (err) => {
    console.error(`[ERR] reading request body: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(400, { 'content-type': 'text/plain' });
      res.end('bad request\n');
    }
  });
  req.on('end', () => {
    handleRequest(req, res, Buffer.concat(chunks, total), ++reqCounter);
  });
});

server.listen(PORT, () => {
  console.log('LLM Gateway listening on http://localhost:' + PORT);
  console.log('Forwarding to   : ' + UPSTREAM_URL);
  console.log('Auth            : UPSTREAM_TOKEN set (masked in logs unless LOG_AUTH=1)');
  console.log('Log file        : ' + (LOG_FILE || '(stdout only)'));
  console.log('运行日志        : ' + (logFileStream
    ? GATEWAY_LOG_FILE + ' (与终端输出一致)'
    : '(仅终端 — GATEWAY_LOG_FILE 已关闭)'));
  console.log('协议转换        : ' + (
    [CONVERT_ANTHROPIC ? 'anthropic→chat (/v1/messages)' : null,
     CONVERT_RESPONSES ? 'responses→chat (/v1/responses)' : null].filter(Boolean).join(', ')
    || '(off — 已用 CONVERT_ANTHROPIC=0 / CONVERT_RESPONSES=0 全部关闭, 纯透传)'));
  if (CONVERT_ANTHROPIC || CONVERT_RESPONSES) {
    console.log('Chat 目标        : ' + chatCompletionsTarget().href
      + (UPSTREAM_CHAT_PATH ? ' (UPSTREAM_CHAT_PATH)' : ' (自动推导)'));
    if (ATTACH_REASONING) {
      console.log('ATTACH_REASONING : 开启 — 转换时附挂 reasoning_content (思考型上游)');
    }
    console.log('内联 system 归一 : ' + (NORMALIZE_INLINE_SYSTEM
      ? '开启 — messages[] 内所有 role:"system" 按 user 发送 (NORMALIZE_INLINE_SYSTEM=0 关闭)'
      : '关闭 — 按原样转发'));
    console.log('空响应兜底      : ' + ({
      auto: 'auto — 有思考内容就当正文回吐, 否则补说明文本 (默认)',
      text: 'text — 一律补一段可见说明文本',
      error: 'error — 用 error 事件中止本轮 (仅流式, 非流式同 text)',
      pass: 'pass — 原样透传 (客户端会显示 Done 但没有任何输出)'
    }[EMPTY_RESPONSE_MODE] || EMPTY_RESPONSE_MODE));
    console.log('空响应透明重试  : ' + (EMPTY_RESPONSE_RETRIES > 0
      ? `开启 — 零字节空响应自动重发上游请求, 最多重试 ${EMPTY_RESPONSE_RETRIES} 次 (仅流式)`
      : '关闭 (EMPTY_RESPONSE_RETRIES=0)'));
  }
  try {
    const upUrl = new URL(UPSTREAM_URL);
    const defaultProxy = getProxyFor(upUrl);
    console.log('Proxy           : ' + (process.env.GATEWAY_PROXY
      ? 'GATEWAY_PROXY → ' + process.env.GATEWAY_PROXY
      : (defaultProxy || '(none — direct connect)')));
    const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(upUrl.hostname);
    if (!process.env.GATEWAY_PROXY && !defaultProxy && !isLoopback) {
      console.log('WARN: 未检测到代理环境变量 (https_proxy/http_proxy/all_proxy),');
      console.log('      出站请求将直连 — 若网络要求代理, 请设置 GATEWAY_PROXY=http://your-proxy:port');
    }
  } catch { /* ignore */ }
  console.log('');
  console.log('  Claude Code CLI:  ANTHROPIC_BASE_URL=http://localhost:' + PORT + ' claude');
  console.log('  Codex CLI     :  见 README.md 中的 ~/.codex/config.toml 配置');
  console.log('');
});
