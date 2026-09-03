# LLM Gateway —— 记录出站请求/响应的转发代理

把 Claude Code CLI 或 Codex CLI 的 base_url 指向本 gateway,gateway 会:

1. **打印记录** 每次出站 HTTP 请求的 payload(headers + body)和响应(状态 + body,SSE 流逐事件打印);
2. **转发** 到指定的外部服务器 `UPSTREAM_URL`,并用 `UPSTREAM_TOKEN` 重写 Authorization(两者必填,缺失时启动报错退出);
3. **协议转换** (默认全开,设 `CONVERT_ANTHROPIC=0`/`CONVERT_RESPONSES=0` 关闭):把 Anthropic Messages /
   OpenAI Responses 请求转换为 Chat Completions 发给只支持 chat 的上游,响应再转回客户端协议。
4. **路径归一化**: 请求 path 中连续重复的 `/v1` 段会折叠为一个(`/v1/v1/messages` → `/v1/messages`)。
   因此客户端 base URL 误带 `/v1`(如 `ANTHROPIC_BASE_URL=http://localhost:18080/v1`)也能正常匹配协议转换;
   透传时与 `UPSTREAM_URL` 自带的 `/v1` 拼出重复段同样会被折叠。

零依赖,Node.js (≥18)。`server.js` 转发+日志,`convert.js` 协议转换(移植自 cc-switch)。

## 启动

```bash
UPSTREAM_URL=https://api.deepseek.com \
UPSTREAM_TOKEN=sk-your-server-token \
node server.js
```

只设置这两个即可:默认监听 `18080`,协议转换默认全开。缺失任何一个环境变量时启动会提示缺了哪些并退出。

| 环境变量 | 必填 | 说明 |
|---|---|---|
| `UPSTREAM_URL` | ✅ | 外部服务器地址,如 `https://api.deepseek.com` 或 `https://my.server.com/v1`。gateway 把客户端原始 path/query 原样拼到其后;未设置时启动报错退出 |
| `UPSTREAM_TOKEN` | ✅ | 转发时发送 `Authorization: Bearer <token>`;未设置时启动报错退出 |
| `GATEWAY_PORT` | ❌ | 监听端口,默认 `18080` |
| `LOG_FILE` | ❌ | 设置后每条请求额外以 JSONL 追加写入该文件(含完整 body,超限截断) |
| `GATEWAY_LOG_FILE` | ❌ | 运行日志文件,**内容与终端输出完全一致**,默认 `gateway.log`;设 `none` 关闭文件输出 |
| `LOG_AUTH=1` | ❌ | 日志中明文显示 Authorization(默认脱敏为 `Bearer ***`) |
| `MAX_LOG_BYTES` | ❌ | 单个 body 打印上限,默认 262144 (256KB),超出截断 |
| `GATEWAY_PROXY` | ❌ | 强制指定出站代理,如 `http://proxy.host:912`(忽略 `NO_PROXY`);不设置则自动使用环境中的 `https_proxy`/`http_proxy`/`all_proxy` 与 `no_proxy` |
| `CONNECT_TIMEOUT_MS` | ❌ | 代理拨号/CONNECT 超时,默认 `15000`(定位"请求被静默丢弃"的关键) |
| `FIRST_BYTE_TIMEOUT_MS` | ❌ | 上游首字节超时(仅约束响应到达前,响应开始后自动解除),默认 `120000` |
| `CONVERT_ANTHROPIC` | ❌ | 默认 `1`:把 `POST /v1/messages`(Anthropic Messages)请求转换为 Chat Completions 转发,响应再转换回 Anthropic 格式;设 `0` 关闭(该端点纯透传) |
| `CONVERT_RESPONSES` | ❌ | 默认 `1`:把 `POST /v1/responses`(OpenAI Responses)请求转换为 Chat Completions 转发,响应再转换回 Responses 格式;设 `0` 关闭(该端点纯透传) |
| `UPSTREAM_CHAT_PATH` | ❌ | chat completions 端点路径或完整 URL(可带 query,适配 Azure 风格)。默认由 `UPSTREAM_URL` 推导:路径以 `/v1` 结尾补 `/chat/completions`,否则补 `/v1/chat/completions` |
| `ATTACH_REASONING` | ❌ | `1` 时转换把思考内容附挂到 assistant 消息的 `reasoning_content`,并为带 tool_calls 的 assistant 消息补占位(DeepSeek/Kimi 等思考型上游需要;严格 OpenAI 上游会拒绝该字段,默认关闭) |

健康检查: `curl http://localhost:18080/healthz` → `ok`

## 协议转换 (默认开启)

转换逻辑在 `convert.js`(移植自 [cc-switch](https://github.com/farion1231/cc-switch) 的
`transform.rs` / `streaming.rs` / `transform_codex_chat.rs` / `streaming_codex_chat.rs`),
支持两条方向:

| 客户端 | 客户端请求 | 转发给上游 | 回给客户端 |
|---|---|---|---|
| Claude Code CLI | `POST /v1/messages`(Anthropic Messages) | `POST /v1/chat/completions` | Anthropic 格式 (SSE/JSON) |
| Codex CLI (wire_api=responses) | `POST /v1/responses` | `POST /v1/chat/completions` | Responses 格式 (SSE/JSON) |

```bash
# 例: Claude Code 与 Codex 都指向 gateway, 上游是只支持 chat completions 的 provider
# (转换默认全开, 只需设置上游地址和 key)
UPSTREAM_URL=https://api.deepseek.com \
UPSTREAM_TOKEN=sk-xxx \
node server.js
# Azure OpenAI 风格 (自带 api-version query):
#   UPSTREAM_CHAT_PATH=https://xxx.openai.azure.com/openai/deployments/gpt-4o/chat/completions?api-version=2025-01-01-preview
# 思考型上游 (DeepSeek/Kimi 需要 assistant tool-call 消息带 reasoning_content):
#   附加 ATTACH_REASONING=1
# 纯透传模式 (上游原生支持客户端协议时):
#   CONVERT_ANTHROPIC=0 CONVERT_RESPONSES=0 UPSTREAM_URL=... UPSTREAM_TOKEN=... node server.js
```

转换覆盖(与 cc-switch 对齐):

- **Anthropic → chat**: system(billing header 剥离)→ system 消息;tool_use → `tool_calls`
  (规范 JSON);tool_result → tool 消息(内含图片/文件媒体块提取为合成 user 消息);
  thinking → `reasoning_effort`(o 系列/gpt-5+/grok 模型);o 系列用 `max_completion_tokens`;
  tool_choice 映射 (`any`→`required`);流式自动注入 `stream_options.include_usage`。
- **chat → Anthropic**: SSE 逐事件转换 (message_start / thinking / text / tool_use /
  input_json_delta / message_delta / message_stop),message_delta 缓存到 `[DONE]`
  统一发出保证 usage 完整;usage 按 `input + cache_read + cache_creation == prompt_tokens`
  拆分。
- **Responses → chat**: instructions → system;function_call/custom_tool_call/tool_search_call
  → `tool_calls`(namespace 压平为 `ns__name`);function_call_output → tool 消息;
  reasoning 前向/回溯附挂(仅 `ATTACH_REASONING=1` 时输出 `reasoning_content`);
  max_output_tokens → max_tokens;tool_choice 映射;系统消息合并到首位。
- **chat → Responses**: 完整 Responses SSE 事件序列 (response.created/in_progress/completed、
  output_item/part/text 生命周期、reasoning summary、function_call_arguments.delta/done);
  非流式输出还原 reasoning/message/function_call items;`finish_reason=length` →
  `incomplete_details`;inline `<think>` 标签剥离为 reasoning;缺名工具调用丢弃,
  全部丢弃时如实报 `response.failed`(cc-switch #4341 语义)。
- **错误体**: 上游 chat 错误按客户端协议规整为 Anthropic `{type:"error",error:{...}}`
  或 Responses `{"error":{"message","type","code","param"}}`,状态码透传。

其它路径(如 `/v1/models`、`/v1/messages/count_tokens`)不受影响,始终透传。

回归测试: `node test-convert.js`(零依赖,20 个用例)。

## 客户端配置

### Claude Code CLI

```bash
export ANTHROPIC_BASE_URL=http://localhost:18080
export ANTHROPIC_API_KEY=any-dummy-value   # gateway 不校验,会被 UPSTREAM_TOKEN 替换
claude
```

### Codex CLI

编辑 `~/.codex/config.toml`(注意:仅用户级配置生效,项目级会被忽略):

```toml
model = "your-model-id"            # 外部服务器期望的模型 ID
model_provider = "gateway"

[model_providers.gateway]
name = "LLM Gateway"
base_url = "http://localhost:18080/v1"   # Codex 会 POST 到 /v1/responses
env_key = "GATEWAY_API_KEY"             # 运行前 export GATEWAY_API_KEY=任意值
wire_api = "responses"
```

> `openai`/`ollama`/`lmstudio` 是保留 provider ID,不能覆盖,请用自定义 ID(如 `gateway`)。

## 日志示例

```
[#3] protocol convert : anthropic -> chat/completions (150 bytes)
================ REQ #3 2026-09-02T05:32:53.000Z ================
[#3] client → gateway : POST /v1/messages
[#3] request headers  : { "anthropic-version": "2023-06-01", "authorization": "Bearer ***", ... }
[#3] request body (113 bytes):
[#3]   { "model": "...", "stream": true, "messages": [ ... ] }
[#3] gateway → upstream: POST http://localhost:9001/v1/chat/completions
[#3] outbound headers : { ..., "authorization": "Bearer ***" }
================ RESP #3 <- 200 OK in 218 ms ================
[#3] response headers : { "content-type": "text/event-stream", ... }
[#3] [SSE data]
[#3]   { "type": "content_block_delta", "delta": { "type": "text_delta", "text": "..." } }
[#3] [usage] {"output_tokens":25}
```

## 出站代理 (Network Proxy)

Node 核心 `http`/`https` **不会自动读取代理环境变量**,gateway 已手动实现:

- 选择顺序:`GATEWAY_PROXY`(强制)> 按目标协议取 `https_proxy`/`http_proxy` > `all_proxy`(含大写形式)
- `no_proxy`/`NO_PROXY` 旁路列表生效(逗号分隔,域名后缀匹配,支持 `*` 和 `.example.com`)
- HTTPS 上游走 **CONNECT 隧道** + TLS;HTTP 上游走 **absolute-form** 转发
- 支持 `http://user:pass@proxy.host:port` 形式的基本认证,以及 `https://` 协议的代理
- 公司 MITM 代理的自签 CA 证书可用 `NODE_EXTRA_CA_CERTS=/path/to/ca.pem` 注入
- 每条请求日志会打印实际使用的代理:`[#1] proxy : http://proxy-ir.intel.com:912 (CONNECT)`

### 出站进度日志

每条请求都会打印出站连接的逐阶段进度(带耗时),请求发不出去时能直接看到卡在哪一步:

```
[#1] proxy            : http://proxy-ir.intel.com:912
[#1] [proxy] 解析代理域名 proxy-ir.intel.com …
[#1] [proxy] proxy-ir.intel.com → 10.x.x.x, 正在连接 http://10.x.x.x:912 …
[#1] [proxy] 代理 tcp 已连接 (12ms), 发送 CONNECT api.example.com:443
[#1] [proxy] CONNECT 响应: 200 (34ms)          ← 非 200 时打印被拒原因 (403/407 …)
[#1] [proxy] 到上游的 TLS 已建立 (56ms)
[#1] outbound request 已写出 (113 bytes, +58ms) — 等待上游响应
```

常见卡点对照:
- 停在 `正在连接` 且 15s 后报 `proxy 无响应` → 到代理的 TCP 被防火墙静默丢弃
- `连接代理失败: ECONNREFUSED/EHOSTUNREACH/ENOTFOUND` → 代理地址/端口/域名不对
- `CONNECT 被拒绝: 403/407` → 代理策略拒绝(407 需在代理 URL 带账号)
- TLS 握手失败 → 公司 MITM 代理场景,设 `NODE_EXTRA_CA_CERTS=<ca.pem>`
- 写出后 `FIRST_BYTE_TIMEOUT_MS` 内无响应 → 上游服务器未响应
- 日志中 `proxy : (direct)` 但网络要求代理 → 启动该 gateway 的 shell 没继承代理环境变量,加 `GATEWAY_PROXY` 即可(启动时也会有 WARN)

无需任何配置,gateway 会自动继承 shell 中预设的代理环境变量(与 curl/Claude Code 行为一致)。

## 实现说明

- **流式(SSE)**: 边转发边按行解析打印,带背压处理(`drain` 时暂停上游);自动提取 `message_delta.usage` / `response.usage` 打印 token 用量。转换模式下 SSE 逐行喂给 `convert.js` 的流式转换器,出站帧逐事件打印并写回客户端。
- **非流式**: 攒完整 body,打印后一次性回给客户端(转换模式先转换再返回,转换失败时原样透传)。
- **请求体**: 先缓冲完整请求再转发,保证 payload 完整记录(CLI 请求体都很小)。
- **转发时**剥离逐跳头(connection/transfer-encoding 等)和 `accept-encoding`,强制上游返回明文以便记录;转换模式额外剥离 `anthropic-version`/`anthropic-beta`/`x-api-key`,并改写出站 path 为 chat completions 端点。
- **记录**: JSONL 记录(转换模式)同时含原始请求体(`request_body_original`)、转换后请求体(`request_body`)与上游原始响应体(`response_body_upstream`)。
- **客户端中断**: 自动终止上游请求;上游错误返回 502。

## 本地联调

仓库自带 `mock-upstream.js`(按请求中 `stream:true` 返回 SSE 或 JSON):

```bash
node mock-upstream.js 9001
UPSTREAM_URL=http://localhost:9001 UPSTREAM_TOKEN=test-token node server.js
# 转换默认开启: POST /v1/messages 会被转成 /v1/chat/completions 发给 mock
curl -N -X POST http://localhost:18080/v1/messages -H 'content-type: application/json' \
  -d '{"stream":true,"messages":[{"role":"user","content":"hi"}]}'
# 纯透传回归需关闭转换: CONVERT_ANTHROPIC=0 CONVERT_RESPONSES=0 ...
```

## 注意事项

- 日志包含完整对话内容和 token,注意终端历史与 `LOG_FILE` 的存放位置。
- 运行日志自动写入 `gateway.log`(追加模式,会持续增长),定期清理;用 `GATEWAY_LOG_FILE=none` 可关闭。
- 18080 若被占用,换 `GATEWAY_PORT` 即可。
