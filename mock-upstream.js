#!/usr/bin/env node
/**
 * Mock upstream —— 本地测试 gateway 用
 * 端点:
 *   * /chat/completions (任意路径以 /chat/completions 结尾) — OpenAI Chat Completions 模拟:
 *     stream:true 返回 chat SSE (文本增量 + usage chunk + [DONE]);
 *     非流式返回 chat completion JSON。
 *     MOCK_CHAT_TOOL=1 时, 若请求带 tools, 返回一个对首个工具的 tool_calls 回复。
 *   * 其它路径 — Anthropic Messages 模拟 (透传模式回归用):
 *     stream:true 返回 Anthropic SSE, 否则返回 message JSON。
 * 用法: node mock-upstream.js [port]                    (默认 9001, 纯 HTTP)
 *       TLS_CERT=cert.pem TLS_KEY=key.pem node mock-upstream.js 9443   (HTTPS)
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');

const PORT = parseInt(process.argv[2] || '9001', 10);
const MOCK_CHAT_TOOL = process.env.MOCK_CHAT_TOOL === '1';

const sse = (data) => `data: ${data}\n\n`;

function chatStreamEvents(body) {
  const created = Math.floor(Date.now() / 1000);
  const base = { id: 'chatcmpl_mock_123', object: 'chat.completion.chunk',
    created, model: body.model || 'mock-model' };
  const events = [
    sse(JSON.stringify({ ...base,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })),
    sse(JSON.stringify({ ...base,
      choices: [{ index: 0, delta: { content: '你好, 这是 mock' }, finish_reason: null }] })),
    sse(JSON.stringify({ ...base,
      choices: [{ index: 0, delta: { content: ' chat 上游的流式回复。' }, finish_reason: null }] })),
  ];
  if (MOCK_CHAT_TOOL && Array.isArray(body.tools) && body.tools.length > 0) {
    const tool = body.tools[0].function || {};
    const name = tool.name || 'mock_tool';
    events.push(
      sse(JSON.stringify({ ...base,
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_mock_1', type: 'function',
          function: { name, arguments: '' } }] }, finish_reason: null }] })),
      sse(JSON.stringify({ ...base,
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0,
          function: { arguments: '{"city":"Beijing"}' } }] }, finish_reason: 'tool_calls' }] })),
    );
  } else {
    events.push(
      sse(JSON.stringify({ ...base,
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })),
    );
  }
  events.push(
    sse(JSON.stringify({ ...base,
      choices: [],
      usage: { prompt_tokens: 12, completion_tokens: 25, total_tokens: 37,
        prompt_tokens_details: { cached_tokens: 5 } } })),
    sse('[DONE]'),
  );
  return events;
}

function chatJsonResponse(body) {
  const message = { role: 'assistant', content: 'mock 非流式回复, 收到你的请求' };
  if (MOCK_CHAT_TOOL && Array.isArray(body.tools) && body.tools.length > 0) {
    const name = (body.tools[0].function || {}).name || 'mock_tool';
    message.content = null;
    message.tool_calls = [{
      id: 'call_mock_2', type: 'function',
      function: { name, arguments: '{"city":"Shanghai"}' }
    }];
  }
  return {
    id: 'chatcmpl_mock_456',
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: body.model || 'mock-model',
    choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 30, total_tokens: 42,
      prompt_tokens_details: { cached_tokens: 5 } },
  };
}

const handler = (req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const bodyStr = Buffer.concat(chunks).toString('utf8');
    console.log(`[mock] ${req.method} ${req.url} auth=${req.headers.authorization || '(none)'}`);
    let body = {};
    try { body = JSON.parse(bodyStr); } catch { /* 保持空对象 */ }

    if (req.url.includes('/chat/completions')) {
      // ---- OpenAI Chat Completions 模拟 ----
      if (body.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const events = chatStreamEvents(body);
        let i = 0;
        const timer = setInterval(() => {
          if (i < events.length) {
            res.write(events[i++]);
          } else {
            clearInterval(timer);
            res.end();
          }
        }, 200);
        // 注意: 不能用 req.on('close') —— Node 15+ 里它在请求体读完时就触发
        res.on('close', () => clearInterval(timer));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(chatJsonResponse(body)));
      return;
    }

    // ---- Anthropic Messages 模拟 (透传模式回归用) ----
    if (bodyStr.includes('"stream":true') || bodyStr.includes('"stream": true')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const events = [
        'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_mock_123","usage":{"input_tokens":12,"output_tokens":1}}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"你好, 这是 mock"}}\n\n',
        'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" 上游的流式回复。"}}\n\n',
        'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":25}}\n\n',
        'event: message_stop\ndata: {"type":"message_stop"}\n\n',
      ];
      let i = 0;
      const timer = setInterval(() => {
        if (i < events.length) {
          res.write(events[i++]);
        } else {
          clearInterval(timer);
          res.end();
        }
      }, 200);
      // 注意: 不能用 req.on('close') —— Node 15+ 里它在请求体读完时就触发
      res.on('close', () => clearInterval(timer));
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: 'msg_mock_456',
      type: 'message',
      content: [{ type: 'text', text: 'mock 非流式回复, 收到你的请求: ' + req.url }],
      usage: { input_tokens: 12, output_tokens: 30 },
    }));
  });
};

const useTls = !!(process.env.TLS_CERT && process.env.TLS_KEY);
const server = useTls
  ? https.createServer({ cert: fs.readFileSync(process.env.TLS_CERT), key: fs.readFileSync(process.env.TLS_KEY) }, handler)
  : http.createServer(handler);

server.listen(PORT, () => {
  console.log(`mock upstream listening on ${useTls ? 'https' : 'http'}://localhost:${PORT}`);
});
