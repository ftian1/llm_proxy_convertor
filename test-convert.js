#!/usr/bin/env node
/**
 * convert.js 回归测试 (零依赖, node:assert)
 * 用法: node test-convert.js
 * 覆盖: 请求转换 (anthropic/responses -> chat), 非流式响应转换,
 *       两条 SSE 流式状态机 (chat -> anthropic / chat -> responses),
 *       错误体转换、媒体提取、thinking/reasoning、inline <think>。
 */
'use strict';

const assert = require('assert');
const c = require('./convert.js');

let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log(`ok - ${name}`);
}

// ---------------------------------------------------------------------------
// 请求转换: anthropic -> chat
// ---------------------------------------------------------------------------

test('anthropic 基础请求 (system/max_tokens/stream/tools)', () => {
  const chat = c.anthropicToOpenAI({
    model: 'deepseek-chat', max_tokens: 8192, stream: true,
    system: [{ type: 'text', text: 'x-anthropic-billing-header: cch=abc\nYou are helpful.', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'bash', description: 'run bash', input_schema: { type: 'object', properties: { command: { type: 'string' } } } }],
  });
  assert.strictEqual(chat.model, 'deepseek-chat');
  assert.strictEqual(chat.messages[0].role, 'system');
  assert.strictEqual(chat.messages[0].content, 'You are helpful.'); // billing header 已剥除
  assert.strictEqual(chat.messages[1].content, 'hi');
  assert.strictEqual(chat.max_tokens, 8192);
  assert.deepStrictEqual(chat.tools[0].function.parameters.type, 'object');
  assert.strictEqual(chat.stream_options.include_usage, true); // usage 注入
});

test('anthropic messages[] 内的 system 归一为 user (Claude Code 后台任务通知)', () => {
  const notif = [{ type: 'text', text: '[SYSTEM NOTIFICATION - NOT USER INPUT]\n'
    + 'No human input has been received since the last genuine user message.\n'
    + '<task-notification>\n<task-id>abc</task-id>\n<status>completed</status>\n</task-notification>' }];
  const body = {
    model: 'm',
    system: 'top-level system',
    messages: [
      { role: 'user', content: 'hi' },
      { role: 'system', content: 'CLAUDE.md / env 上下文 (中间位置)' },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: '' },
      { role: 'system', content: notif },
    ],
  };
  const chat = c.anthropicToOpenAI(body);
  // 顶层 system 保留在首位; messages[] 内的 system (含中间位置) 全部归一为 user ——
  // 部分上游 (Qwen 兼容接口) 对非首位 system 直接 400 "System message must be at the beginning."
  assert.deepStrictEqual(chat.messages.map((m) => m.role),
    ['system', 'user', 'user', 'assistant', 'user', 'user']);
  // 内容逐字保留, 只动 role 字段
  assert.strictEqual(chat.messages[2].content, 'CLAUDE.md / env 上下文 (中间位置)');
  assert.strictEqual(chat.messages[5].content, notif[0].text);

  // 关闭开关时全部原样保留; 与开启时相比只有 role 不同, 内容逐字节一致
  const off = c.anthropicToOpenAI(body, { normalizeInlineSystem: false });
  assert.deepStrictEqual(off.messages.map((m) => m.role),
    ['system', 'user', 'system', 'assistant', 'user', 'system']);
  assert.strictEqual(off.messages.length, chat.messages.length);
  for (let i = 0; i < off.messages.length; i += 1) {
    assert.strictEqual(chat.messages[i].content, off.messages[i].content);
  }
});

test('anthropic tool_use/tool_result/thinking 历史转换', () => {
  const chat = c.anthropicToOpenAI({
    model: 'm',
    messages: [
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'secret' }, { type: 'tool_use', id: 'tu_1', name: 'bash', input: { command: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'a.txt' }] },
    ],
  });
  const assistant = chat.messages.find((m) => m.role === 'assistant');
  assert.deepStrictEqual(assistant.tool_calls[0], {
    id: 'tu_1', type: 'function',
    function: { name: 'bash', arguments: '{"command":"ls"}' }, // 规范 JSON (键排序)
  });
  assert.strictEqual(assistant.reasoning_content, undefined); // 默认不透传 thinking
  const tool = chat.messages.find((m) => m.role === 'tool');
  assert.strictEqual(tool.tool_call_id, 'tu_1');
  assert.strictEqual(tool.content, 'a.txt');
});

test('anthropic tool_choice 与 o-series max_completion_tokens', () => {
  assert.strictEqual(c.anthropicToOpenAI({ model: 'm', tool_choice: 'any', messages: [] }).tool_choice, 'required');
  assert.deepStrictEqual(
    c.anthropicToOpenAI({ model: 'm', tool_choice: { type: 'tool', name: 'x' }, messages: [] }).tool_choice,
    { type: 'function', function: { name: 'x' } }
  );
  const o = c.anthropicToOpenAI({ model: 'o3', max_tokens: 500, messages: [] });
  assert.strictEqual(o.max_completion_tokens, 500);
  assert.strictEqual(o.max_tokens, undefined);
});

test('anthropic thinking -> reasoning_effort', () => {
  assert.strictEqual(c.anthropicToOpenAI({ model: 'gpt-5', thinking: { type: 'adaptive' }, messages: [] }).reasoning_effort, 'xhigh');
  assert.strictEqual(c.anthropicToOpenAI({ model: 'gpt-5', output_config: { effort: 'low' }, messages: [] }).reasoning_effort, 'low');
  assert.strictEqual(c.anthropicToOpenAI({ model: 'gpt-4o', thinking: { type: 'adaptive' }, messages: [] }).reasoning_effort, undefined);
});

test('工具输出媒体提取为合成 user 消息', () => {
  const chat = c.anthropicToOpenAI({
    model: 'm',
    messages: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [
      { type: 'text', text: 'file content' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ] }] }],
  });
  assert.strictEqual(chat.messages[0].role, 'tool');
  assert.strictEqual(chat.messages[1].role, 'user');
  assert.ok(chat.messages[1].content.some((p) => p.type === 'image_url' && p.image_url.url.startsWith('data:image/png')));
});

// ---------------------------------------------------------------------------
// 请求转换: responses -> chat
// ---------------------------------------------------------------------------

test('responses 基础请求 (instructions/input/tools/参数)', () => {
  const ctx = new c.ToolContext();
  ctx.buildFromRequest({ tools: [{ type: 'function', name: 'shell', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }] });
  const chat = c.responsesToChatCompletions({
    model: 'gpt-5', max_output_tokens: 4096, stream: true,
    instructions: 'You are Codex.',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'run ls' }] }],
    tools: [{ type: 'function', name: 'shell', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }],
  });
  assert.strictEqual(chat.messages[0].role, 'system');
  assert.strictEqual(chat.messages[1].content, 'run ls');
  assert.strictEqual(chat.max_tokens, 4096);
  assert.strictEqual(chat.tools[0].function.name, 'shell');
  assert.strictEqual(chat.stream_options.include_usage, true);
  // tool context 用于响应方向还原
  assert.strictEqual(ctx.chatNameForResponseFunction('shell', undefined), 'shell');
});

test('responses 函数调用历史 (function_call/output/reasoning 边界)', () => {
  const chat = c.responsesToChatCompletions({
    model: 'm',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'go' }] },
      { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{"cmd":"ls"}' },
      { type: 'function_call_output', call_id: 'c1', output: 'a.txt' },
      { role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
    ],
  });
  const assistant = chat.messages.find((m) => m.role === 'assistant');
  assert.deepStrictEqual(assistant.tool_calls[0].function, { name: 'shell', arguments: '{"cmd":"ls"}' });
  const tool = chat.messages.find((m) => m.role === 'tool');
  assert.strictEqual(tool.tool_call_id, 'c1');
  assert.strictEqual(tool.content, 'a.txt');
});

test('responses 多模态 content (image_url)', () => {
  const chat = c.responsesToChatCompletions({
    model: 'm',
    input: [{ role: 'user', content: [
      { type: 'input_text', text: 'look' },
      { type: 'input_image', image_url: 'https://x/y.png' },
    ] }],
  });
  const content = chat.messages[0].content;
  assert.ok(Array.isArray(content));
  assert.strictEqual(content[1].type, 'image_url');
  assert.strictEqual(content[1].image_url.url, 'https://x/y.png');
});

test('ATTACH_REASONING: reasoning 附挂 assistant + tool-call 占位', () => {
  const chat = c.responsesToChatCompletions({
    model: 'deepseek-reasoner',
    input: [
      { role: 'user', content: [{ type: 'input_text', text: 'go' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'I should call the tool' }] },
      { type: 'function_call', call_id: 'c1', name: 'shell', arguments: '{}' },
      { type: 'function_call_output', call_id: 'c1', output: 'ok' },
    ],
  }, { attachReasoning: true });
  const assistant = chat.messages.find((m) => m.role === 'assistant' && m.tool_calls);
  assert.ok(assistant.reasoning_content.includes('I should call the tool'));
  // 不带 reasoning 的 assistant tool-call 消息补占位
  const chat2 = c.responsesToChatCompletions({
    model: 'deepseek-reasoner',
    input: [{ type: 'function_call', call_id: 'c2', name: 'shell', arguments: '{}' }],
  }, { attachReasoning: true });
  assert.strictEqual(chat2.messages[0].reasoning_content, 'tool call');
});

test('namespace 工具压平与还原', () => {
  const ctx = new c.ToolContext();
  ctx.addResponseTool({ type: 'namespace', name: 'mcp_ns', tools: [{ type: 'function', name: 'search' }] });
  assert.strictEqual(ctx.chatNameForResponseFunction('search', 'mcp_ns'), 'mcp_ns__search');
  assert.strictEqual(ctx.lookup('mcp_ns__search').kind, 'namespace');
});

// ---------------------------------------------------------------------------
// 非流式响应转换
// ---------------------------------------------------------------------------

test('openaiToAnthropic: 文本/工具调用/usage/refusal', () => {
  const out = c.openaiToAnthropic({
    id: 'chatcmpl_1', model: 'gpt-4o',
    choices: [{
      finish_reason: 'tool_calls',
      message: { content: null, refusal: null, tool_calls: [
        { id: 'call_1', function: { name: 'bash', arguments: '{"cmd":"ls"}' } },
      ] },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } },
  });
  assert.strictEqual(out.type, 'message');
  assert.strictEqual(out.stop_reason, 'tool_use');
  assert.strictEqual(out.content[0].type, 'tool_use');
  assert.deepStrictEqual(out.content[0].input, { cmd: 'ls' });
  assert.strictEqual(out.usage.input_tokens, 6); // 10 - 4 cached
  assert.strictEqual(out.usage.cache_read_input_tokens, 4);
});

test('openaiToAnthropic: reasoning_content -> thinking 块', () => {
  const out = c.openaiToAnthropic({
    choices: [{ finish_reason: 'stop', message: { reasoning_content: 'thinking...', content: 'answer' } }],
  });
  assert.strictEqual(out.content[0].type, 'thinking');
  assert.strictEqual(out.content[1].text, 'answer');
});

test('chatCompletionToResponse: 输出结构/usage/incomplete', () => {
  const ctx = new c.ToolContext();
  ctx.buildFromRequest({ tools: [{ type: 'function', name: 'shell' }] });
  const out = c.chatCompletionToResponse({
    id: 'chatcmpl_1', created: 123, model: 'gpt-5',
    choices: [{ finish_reason: 'stop', message: { content: 'done' } }],
    usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14, prompt_tokens_details: { cached_tokens: 5 } },
  }, ctx);
  assert.strictEqual(out.id, 'resp_chatcmpl_1');
  assert.strictEqual(out.status, 'completed');
  assert.strictEqual(out.output[0].content[0].text, 'done');
  assert.strictEqual(out.usage.input_tokens_details.cached_tokens, 5);
  const inc = c.chatCompletionToResponse({
    choices: [{ finish_reason: 'length', message: { content: 'cut' } }],
  });
  assert.strictEqual(inc.status, 'incomplete');
  assert.strictEqual(inc.incomplete_details.reason, 'max_output_tokens');
});

test('chatCompletionToResponse: 缺名工具调用全部丢弃时报错 (#4341)', () => {
  assert.throws(() => c.chatCompletionToResponse({
    choices: [{ finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'x', function: { arguments: '{}' } }] } }],
  }));
});

// ---------------------------------------------------------------------------
// 流式转换: chat SSE -> anthropic SSE
// ---------------------------------------------------------------------------

test('AnthropicStreamConverter: 文本/并行工具调用/usage/message_delta 去重', () => {
  const a = new c.AnthropicStreamConverter();
  const feed = [
    JSON.stringify({ id: 'chatcmpl_1', model: 'm', choices: [{ delta: { content: 'Hel' } }] }),
    JSON.stringify({ id: 'chatcmpl_1', choices: [{ delta: { content: 'lo' } }] }),
    JSON.stringify({ id: 'chatcmpl_1', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'first_tool' } }] } }] }),
    JSON.stringify({ id: 'chatcmpl_1', choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_b', type: 'function', function: { name: 'second_tool' } }] } }] }),
    JSON.stringify({ id: 'chatcmpl_1', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"a":1}' } }] } }] }),
    JSON.stringify({ id: 'chatcmpl_1', choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '{"b":2}' } }] } }] }),
    JSON.stringify({ id: 'chatcmpl_1', choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 8, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } } }),
    '[DONE]',
  ];
  const out = feed.map((d) => a.push(d).join('')).join('') + a.flush().join('');
  const types = [...out.matchAll(/event: (\w+)/g)].map((m) => m[1]);
  assert.strictEqual(types.filter((t) => t === 'message_start').length, 1);
  assert.strictEqual(types.filter((t) => t === 'message_delta').length, 1); // 去重
  assert.strictEqual(types.filter((t) => t === 'message_stop').length, 1);
  assert.strictEqual(types.filter((t) => t === 'content_block_start').length, 3); // text + 2 tools
  assert.ok(out.includes('"partial_json":"{\\"a\\":1}"'));
  const delta = JSON.parse(out.match(/event: message_delta\ndata: (.*)/)[1]);
  assert.strictEqual(delta.delta.stop_reason, 'tool_use');
  assert.strictEqual(delta.usage.cache_read_input_tokens, 3);
  assert.strictEqual(delta.usage.input_tokens, 5);
});

test('AnthropicStreamConverter: reasoning_content -> thinking 块 + 上游错误事件', () => {
  const a = new c.AnthropicStreamConverter();
  let out = a.push(JSON.stringify({ id: 'y', choices: [{ delta: { reasoning_content: 'thinking...' } }] }));
  out += a.push(JSON.stringify({ id: 'y', choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }));
  out += a.push('[DONE]');
  assert.ok(out.includes('"type":"thinking"'));
  assert.ok(out.includes('thinking_delta'));
  assert.ok(out.includes('text_delta'));
  const b = new c.AnthropicStreamConverter();
  const err = b.push(JSON.stringify({ error: { message: 'boom', type: 'invalid_request_error' } })).join('');
  assert.ok(err.includes('event: error'));
  assert.ok(err.includes('"message":"boom"'));
});

// ---------------------------------------------------------------------------
// 流式转换: chat SSE -> responses SSE
// ---------------------------------------------------------------------------

test('ResponsesStreamConverter: 完整事件序列 (文本+工具调用+usage)', () => {
  const ctx = new c.ToolContext();
  ctx.buildFromRequest({ tools: [{ type: 'function', name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } } } }] });
  const r = new c.ResponsesStreamConverter(ctx);
  const feed = [
    JSON.stringify({ id: 'chatcmpl_2', created: 123, model: 'gpt-5', choices: [{ delta: { content: 'Now answer.' } }] }),
    JSON.stringify({ id: 'chatcmpl_2', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather' } }] } }] }),
    JSON.stringify({ id: 'chatcmpl_2', choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"city":"Tokyo"}' } }] }, finish_reason: 'tool_calls' }] }),
    '[DONE]',
  ];
  const out = feed.map((d) => r.push(d).join('')).join('') + r.flush().join('');
  assert.ok(out.includes('event: response.created'));
  assert.ok(out.includes('event: response.in_progress'));
  assert.ok(out.includes('event: response.output_text.delta'));
  assert.ok(out.includes('event: response.function_call_arguments.delta'));
  assert.ok(out.includes('event: response.function_call_arguments.done'));
  assert.ok(out.includes('event: response.completed'));
  const completed = JSON.parse(out.match(/event: response.completed\ndata: (.*)/)[1]);
  assert.strictEqual(completed.response.status, 'completed');
  assert.strictEqual(completed.response.output[0].type, 'message');
  assert.strictEqual(completed.response.output[1].type, 'function_call');
  assert.strictEqual(completed.response.output[1].arguments, '{"city":"Tokyo"}');
});

test('ResponsesStreamConverter: reasoning + inline <think> 不泄漏标签', () => {
  const r = new c.ResponsesStreamConverter(new c.ToolContext());
  let out = r.push(JSON.stringify({ id: 'x', choices: [{ delta: { reasoning_content: 'Need context. ' } }] }));
  out += r.push(JSON.stringify({ id: 'x', choices: [{ delta: { content: 'pong' }, finish_reason: 'stop' }] }));
  out += r.push('[DONE]');
  assert.ok(out.includes('event: response.reasoning_summary_text.delta'));
  assert.ok(out.includes('event: response.reasoning_summary_text.done'));
  const completed = JSON.parse(out.match(/event: response.completed\ndata: (.*)/)[1]);
  assert.strictEqual(completed.response.output[0].type, 'reasoning');
  assert.strictEqual(completed.response.output[1].content[0].text, 'pong');

  const r2 = new c.ResponsesStreamConverter(new c.ToolContext());
  let out2 = r2.push(JSON.stringify({ id: 'y', choices: [{ delta: { content: '<think>\nNeed context.</think>\n\npong' } }] }));
  out2 += r2.push(JSON.stringify({ id: 'y', choices: [{ delta: {}, finish_reason: 'stop' }] }));
  out2 += r2.push('[DONE]');
  assert.ok(out2.includes('event: response.reasoning_summary_text.delta'));
  assert.ok(!out2.includes('<think>'));
  assert.ok(!out2.includes('</think>'));
  assert.ok(out2.includes('"delta":"pong"'));
});

test('ResponsesStreamConverter: 流截断 -> response.failed / 缺名工具调用 -> tool_call_dropped', () => {
  // 无任何输出即结束 -> stream_truncated
  const r = new c.ResponsesStreamConverter(new c.ToolContext());
  const out = r.flush().join('');
  assert.ok(out.includes('event: response.failed'));
  assert.ok(out.includes('stream_truncated'));

  // 只有缺名工具调用 -> upstream_tool_call_dropped (不谎报 completed)
  const r2 = new c.ResponsesStreamConverter(new c.ToolContext());
  let out2 = r2.push(JSON.stringify({ id: 'z', choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_bad', type: 'function', function: { arguments: '{}' } }] }, finish_reason: 'tool_calls' }] })).join('');
  out2 += r2.push('[DONE]').join('');
  assert.ok(out2.includes('event: response.failed'));
  assert.ok(out2.includes('upstream_tool_call_dropped'));
  assert.ok(!out2.includes('event: response.completed'));
});

// ---------------------------------------------------------------------------
// 错误体转换
// ---------------------------------------------------------------------------

test('错误体转换 (responses/anthropic)', () => {
  const err = { error: { message: 'bad token', type: 'invalid_request_error', code: 'invalid_api_key' } };
  assert.strictEqual(c.chatErrorToResponseError(err).error.message, 'bad token');
  assert.strictEqual(c.chatErrorToResponseError(err).error.code, 'invalid_api_key');
  assert.strictEqual(c.chatErrorToResponseError(undefined).error.type, 'upstream_error');
  assert.strictEqual(c.chatErrorToResponseError('plain').error.message, 'plain');
  const ae = c.chatErrorToAnthropicError(err);
  assert.strictEqual(ae.type, 'error');
  assert.strictEqual(ae.error.type, 'invalid_request_error');
  assert.strictEqual(ae.error.message, 'bad token');
});

// ---------------------------------------------------------------------------
// 空响应兜底: finish_reason=stop 但整条流没有任何可见 content
// (思考型模型只吐 reasoning 就停, 或 Azure content_filter 把 content 清空)
// ---------------------------------------------------------------------------

const emptyStream = () => [
  JSON.stringify({ id: 'chatcmpl_x', model: 'm', choices: [{ delta: {} }] }),
  JSON.stringify({ id: 'chatcmpl_x', choices: [{ delta: {}, finish_reason: 'stop' }] }),
  '[DONE]',
];
const eventTypes = (out) => [...out.matchAll(/event: (\w+)/g)].map((m) => m[1]);
const drive = (conv, feed) => feed.map((d) => conv.push(d).join('')).join('') + conv.flush().join('');
const frames = (out) => out.split('\n\n').filter(Boolean).map((blk) => ({
  event: blk.match(/^event: (.*)$/m)[1],
  data: JSON.parse(blk.match(/^data: (.*)$/m)[1])
}));
// Anthropic 侧正文 (content_block_delta 里 type=text_delta 的 text 拼接)
const anthropicText = (out) => frames(out)
  .filter((f) => f.event === 'content_block_delta' && f.data.delta.type === 'text_delta')
  .map((f) => f.data.delta.text).join('');
// Responses 侧正文 (response.output_text.delta 的 delta 拼接)
const responsesText = (out) => frames(out)
  .filter((f) => f.event === 'response.output_text.delta')
  .map((f) => f.data.delta).join('');

test('AnthropicStreamConverter: 空响应默认补可见文本 (不再是静默 Done)', () => {
  const a = new c.AnthropicStreamConverter();
  const out = drive(a, emptyStream());
  assert.deepStrictEqual(eventTypes(out), ['message_start', 'content_block_start',
    'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.ok(out.includes('上游返回了空响应')); // 兜底文本
  assert.strictEqual(a.emptyResponseDetected, true);
  assert.strictEqual(a.upstreamFinishReason, 'stop');
});

test('AnthropicStreamConverter: EMPTY_RESPONSE_MODE=error 中止本轮 / pass 原样透传', () => {
  const errConv = new c.AnthropicStreamConverter({ emptyResponseMode: 'error' });
  const errOut = drive(errConv, emptyStream());
  // 零 delta 流: message_start 被延迟且永远不会发, 只有 error 事件 (客户端直接看到请求失败)
  assert.deepStrictEqual(eventTypes(errOut), ['error']);
  assert.ok(!errOut.includes('message_stop')); // 已用 error 事件收尾

  const passConv = new c.AnthropicStreamConverter({ emptyResponseMode: 'pass' });
  const passOut = drive(passConv, emptyStream());
  assert.deepStrictEqual(eventTypes(passOut), ['message_start', 'message_delta', 'message_stop']);
  assert.strictEqual(passConv.emptyResponseDetected, true); // pass 也照样记录告警
});

test('AnthropicStreamConverter: 有可见输出时不触发空响应兜底', () => {
  const a = new c.AnthropicStreamConverter();
  drive(a, [
    JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    '[DONE]',
  ]);
  assert.strictEqual(a.emptyResponseDetected, false);
});

test('AnthropicStreamConverter: 仅 thinking 也算空响应, 且 thinking 块补 signature_delta', () => {
  const a = new c.AnthropicStreamConverter(); // 不传 mode = 默认 auto
  const out = drive(a, [
    JSON.stringify({ choices: [{ delta: { reasoning_content: '想一下' } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    '[DONE]',
  ]);
  assert.ok(out.includes('thinking_delta'));
  assert.ok(out.includes('signature_delta'));
  // 默认 auto: 手里有思考内容 -> 当正文回吐, 而不是补说明文本
  assert.strictEqual(anthropicText(out), '想一下');
  assert.ok(!out.includes('上游返回了空响应'));
  assert.strictEqual(a.emptyResponseDetected, true);
  assert.strictEqual(a.emptyResponseSalvagedReasoning, true);
});

test('AnthropicStreamConverter: content_filter 映射为 refusal 并记录原始 finish_reason', () => {
  const a = new c.AnthropicStreamConverter();
  const out = drive(a, [
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'content_filter' }] }),
    '[DONE]',
  ]);
  const delta = JSON.parse(out.match(/event: message_delta\ndata: (.*)/)[1]);
  assert.strictEqual(delta.delta.stop_reason, 'refusal');
  assert.strictEqual(a.upstreamFinishReason, 'content_filter');
});

// ---------------------------------------------------------------------------
// message_start 延迟 (透明重试的前提): 只有带 role / 空 delta / finish_reason 的
// chunk 不触发, 第一个真实 delta (推理/正文/工具调用) 才发 message_start。
// 这样上游「零内容空 completion」在客户端眼里是零字节, 网关可以整体丢弃重试。
// ---------------------------------------------------------------------------

test('AnthropicStreamConverter: 零 delta 流 push 不发任何帧, 收尾时补发 message_start', () => {
  const a = new c.AnthropicStreamConverter();
  const [c1, c2, done] = emptyStream();
  assert.strictEqual(a.push(c1).join(''), ''); // 空 delta: 不触发 message_start
  assert.strictEqual(a.push(c2).join(''), ''); // 只有 finish_reason: 同样不发
  assert.strictEqual(a.sawRealDelta, false);
  const out = a.push(done).join('') + a.flush().join('');
  // [DONE] 收尾时补发 message_start, 保证 message_delta/message_stop 前有序
  assert.deepStrictEqual(eventTypes(out), ['message_start', 'content_block_start',
    'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
});

test('AnthropicStreamConverter: 第一个真实 delta 才发 message_start, sawRealDelta 置位', () => {
  const a = new c.AnthropicStreamConverter();
  assert.strictEqual(a.push(JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })).join(''), '');
  assert.strictEqual(a.push(JSON.stringify({ choices: [{ delta: {} }] })).join(''), '');
  assert.strictEqual(a.sawRealDelta, false);
  const out = a.push(JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })).join('');
  assert.deepStrictEqual(eventTypes(out), ['message_start', 'content_block_start', 'content_block_delta']);
  assert.strictEqual(a.sawRealDelta, true);
});

test('ResponsesStreamConverter: 零 delta 流 push 不发 response.created, 收尾时补发', () => {
  const r = new c.ResponsesStreamConverter(new c.ToolContext());
  const c1 = JSON.stringify({ id: 'chatcmpl_e', model: 'm', choices: [{ delta: {} }] });
  const c2 = JSON.stringify({ id: 'chatcmpl_e', choices: [{ delta: {}, finish_reason: 'stop' }] });
  assert.strictEqual(r.push(c1).join(''), ''); // 空 delta: 不触发 response.created
  assert.strictEqual(r.push(c2).join(''), ''); // 只有 finish_reason: 同样不发
  assert.strictEqual(r.sawRealDelta, false);
  const out = r.push('[DONE]').join('') + r.flush().join('');
  assert.ok(out.startsWith('event: response.created')); // finalize 兜底补发
});

// ---------------------------------------------------------------------------
// 空响应兜底: responses 协议 (流式 + 非流式)
// ---------------------------------------------------------------------------

test('ResponsesStreamConverter: 空响应默认补可见文本 (不再是静默空回复)', () => {
  const r = new c.ResponsesStreamConverter(new c.ToolContext());
  const out = drive(r, [
    JSON.stringify({ id: 'chatcmpl_e', model: 'm', choices: [{ delta: {} }] }),
    JSON.stringify({ id: 'chatcmpl_e', choices: [{ delta: {}, finish_reason: 'stop' }] }),
    '[DONE]',
  ]);
  assert.ok(out.includes('event: response.output_text.delta'));
  assert.ok(out.includes('上游返回了空响应'));
  assert.ok(out.includes('event: response.completed'));
  assert.strictEqual(r.emptyResponseDetected, true);
  assert.strictEqual(r.upstreamFinishReason, 'stop');
});

test('ResponsesStreamConverter: EMPTY_RESPONSE_MODE=error/pass', () => {
  const errConv = new c.ResponsesStreamConverter(new c.ToolContext(), { emptyResponseMode: 'error' });
  const errOut = drive(errConv, [
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    '[DONE]',
  ]);
  assert.ok(errOut.includes('event: response.failed'));
  assert.ok(!errOut.includes('event: response.completed'));

  const passConv = new c.ResponsesStreamConverter(new c.ToolContext(), { emptyResponseMode: 'pass' });
  const passOut = drive(passConv, [
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    '[DONE]',
  ]);
  assert.ok(!passOut.includes('上游返回了空响应'));
  assert.ok(passOut.includes('event: response.completed'));
  assert.strictEqual(passConv.emptyResponseDetected, true); // pass 也照样记录
});

test('ResponsesStreamConverter: 仅 reasoning / 正常文本 / length 的行为', () => {
  // 只有 reasoning -> 算空响应, 默认 auto 回吐思考内容
  const onlyReasoning = new c.ResponsesStreamConverter(new c.ToolContext());
  const ro = drive(onlyReasoning, [
    JSON.stringify({ choices: [{ delta: { reasoning_content: '想一下' } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    '[DONE]',
  ]);
  assert.strictEqual(responsesText(ro), '想一下');
  assert.ok(!ro.includes('上游返回了空响应'));
  assert.strictEqual(onlyReasoning.emptyResponseSalvagedReasoning, true);

  // 有正文 -> 不兜底
  const withText = new c.ResponsesStreamConverter(new c.ToolContext());
  drive(withText, [
    JSON.stringify({ choices: [{ delta: { content: 'hi' } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    '[DONE]',
  ]);
  assert.strictEqual(withText.emptyResponseDetected, false);

  // length 截断 -> 不兜底, 保持 incomplete
  const truncated = new c.ResponsesStreamConverter(new c.ToolContext());
  const to = drive(truncated, [
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }),
    '[DONE]',
  ]);
  assert.strictEqual(truncated.emptyResponseDetected, false);
  const done = JSON.parse(to.match(/event: response.completed\ndata: (.*)/)[1]);
  assert.strictEqual(done.response.status, 'incomplete');
  assert.strictEqual(done.response.incomplete_details.reason, 'max_output_tokens');
});

test('ResponsesStreamConverter: content_filter -> incomplete/content_filter', () => {
  const r = new c.ResponsesStreamConverter(new c.ToolContext());
  const out = drive(r, [
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'content_filter' }] }),
    '[DONE]',
  ]);
  const done = JSON.parse(out.match(/event: response.completed\ndata: (.*)/)[1]);
  assert.strictEqual(done.response.status, 'incomplete');
  assert.strictEqual(done.response.incomplete_details.reason, 'content_filter');
  assert.ok(out.includes('上游内容过滤拦截了输出'));
  assert.strictEqual(r.upstreamFinishReason, 'content_filter');
});

test('chatCompletionToResponse: 空响应补文本 / content_filter -> incomplete', () => {
  const empty = c.chatCompletionToResponse({
    id: 'chatcmpl_e', model: 'm', created: 1,
    choices: [{ finish_reason: 'stop', message: { content: '' } }],
    usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
  });
  assert.strictEqual(empty.status, 'completed');
  assert.strictEqual(empty.output.length, 1);
  assert.strictEqual(empty.output[0].type, 'message');
  assert.ok(empty.output[0].content[0].text.includes('上游返回了空响应'));

  const filtered = c.chatCompletionToResponse({
    id: 'chatcmpl_f',
    choices: [{ finish_reason: 'content_filter', message: { content: '' } }],
  });
  assert.strictEqual(filtered.status, 'incomplete');
  assert.strictEqual(filtered.incomplete_details.reason, 'content_filter');
  assert.ok(filtered.output[0].content[0].text.includes('上游内容过滤拦截了输出'));

  const pass = c.chatCompletionToResponse({
    choices: [{ finish_reason: 'stop', message: { content: '' } }],
  }, undefined, { emptyResponseMode: 'pass' });
  assert.deepStrictEqual(pass.output, []);
  assert.strictEqual(pass.status, 'completed');
});

// ---------------------------------------------------------------------------
// 空响应兜底默认策略 auto: 思考型模型把整段答案写进 reasoning 通道就停
// (DeepSeek-V4-Pro 长上下文下的退化), 手里有思考内容就当正文回吐, 救回这一轮。
// 不按模型名判断 —— 依据是这条响应本身 (整条流没有可见输出 + 有思考内容)。
// ---------------------------------------------------------------------------

const reasoningOnlyStream = [
  JSON.stringify({ id: 'chatcmpl_r', model: 'm',
    choices: [{ delta: { reasoning_content: '好的, 这是答案正文。' } }] }),
  JSON.stringify({ id: 'chatcmpl_r', choices: [{ delta: {}, finish_reason: 'stop' }] }),
  '[DONE]',
];

test('AnthropicStreamConverter: 默认 auto 把思考内容当正文回吐 (无需任何配置)', () => {
  const a = new c.AnthropicStreamConverter();
  const out = drive(a, reasoningOnlyStream);
  assert.strictEqual(a.emptyResponseDetected, true);
  assert.strictEqual(a.emptyResponseSalvagedReasoning, true);
  assert.strictEqual(a.thinkingText, '好的, 这是答案正文。');
  // 回吐的是模型自己的正文, 不再是 gateway 的说明文本
  assert.ok(!out.includes('上游返回了空响应'));
  assert.strictEqual(anthropicText(out), '好的, 这是答案正文。');
  // 思考块本体照旧发出 (补 signature_delta), 正文另起一个 text 块
  const deltas = frames(out).filter((f) => f.event === 'content_block_delta');
  assert.strictEqual(deltas.filter((d) => d.data.delta.type === 'thinking_delta').length, 1);
  // 仍是合法的 Anthropic 事件序列
  assert.deepStrictEqual(eventTypes(out), ['message_start', 'content_block_start',
    'content_block_delta', 'content_block_delta', 'content_block_stop', 'content_block_start',
    'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
});

test('AnthropicStreamConverter: 没有思考可回吐时退回说明文本', () => {
  const a = new c.AnthropicStreamConverter(); // 默认 auto
  const out = drive(a, emptyStream());
  assert.ok(out.includes('上游返回了空响应'));
  assert.strictEqual(a.emptyResponseDetected, true);
  assert.strictEqual(a.emptyResponseSalvagedReasoning, false);
});

test('AnthropicStreamConverter: EMPTY_RESPONSE_MODE=text 仍可强制只补说明文本', () => {
  const a = new c.AnthropicStreamConverter({ emptyResponseMode: 'text' });
  const out = drive(a, reasoningOnlyStream);
  assert.ok(out.includes('上游返回了空响应'));
  assert.strictEqual(a.emptyResponseDetected, true);
  assert.strictEqual(a.emptyResponseSalvagedReasoning, false);
});

test('ResponsesStreamConverter: 默认 auto 把思考内容当正文回吐', () => {
  const r = new c.ResponsesStreamConverter(new c.ToolContext());
  const out = drive(r, reasoningOnlyStream);
  assert.strictEqual(r.emptyResponseSalvagedReasoning, true);
  assert.ok(!out.includes('上游返回了空响应'));
  assert.strictEqual(responsesText(out), '好的, 这是答案正文。');
  assert.ok(out.includes('event: response.completed'));
});

test('openaiToAnthropic: 非流式空响应兜底 (默认 auto / text / pass)', () => {
  const body = (content, reasoning) => ({
    id: 'chatcmpl_r', model: 'm',
    choices: [{ finish_reason: 'stop', message: { content, reasoning_content: reasoning } }],
    usage: { prompt_tokens: 10, completion_tokens: 7, total_tokens: 17 }
  });

  // 默认 auto: 有思考内容 -> 当正文回吐
  const salvaged = c.openaiToAnthropic(body('', '好的, 这是答案正文。'));
  assert.strictEqual(salvaged.content.length, 2);
  assert.deepStrictEqual(salvaged.content[1], { type: 'text', text: '好的, 这是答案正文。' });

  // text: 强制只补说明文本 (thinking 块保留)
  const note = c.openaiToAnthropic(body('', '想一下'), { emptyResponseMode: 'text' });
  assert.strictEqual(note.content.length, 2);
  assert.strictEqual(note.content[0].type, 'thinking');
  assert.ok(note.content[1].text.includes('上游返回了空响应'));

  // 完全没有 reasoning 可回吐 -> 退回说明文本
  const bare = c.openaiToAnthropic(body('', undefined));
  assert.strictEqual(bare.content.length, 1);
  assert.ok(bare.content[0].text.includes('上游返回了空响应'));

  // pass: 原样返回 (只有 thinking 块)
  const pass = c.openaiToAnthropic(body('', '想一下'), { emptyResponseMode: 'pass' });
  assert.strictEqual(pass.content.length, 1);

  // 有正文时不兜底
  assert.deepStrictEqual(
    c.openaiToAnthropic(body('hi', '想一下')).content,
    [{ type: 'thinking', thinking: '想一下' }, { type: 'text', text: 'hi' }]
  );
});

test('chatCompletionToResponse: 默认 auto 把思考内容当正文回吐', () => {
  const r = c.chatCompletionToResponse({
    id: 'chatcmpl_r', model: 'm', created: 1,
    choices: [{ finish_reason: 'stop',
      message: { content: '', reasoning_content: '好的, 这是答案正文。' } }]
  });
  assert.strictEqual(r.status, 'completed');
  const msg = r.output.find((i) => i.type === 'message');
  assert.strictEqual(msg.content[0].text, '好的, 这是答案正文。');
  assert.ok(!JSON.stringify(r).includes('上游返回了空响应'));
});

// ---------------------------------------------------------------------------
// 上游断流兜底: 上游在发出 finish_reason 之前就结束流 (没有 finish_reason、也没有
// [DONE] —— 长上下文下模型返回完全空的 completion 时 LiteLLM 会这样直接关流)。
// 原来这里什么都不发, 客户端只收到"只有 message_start 就断掉"的流: 不报错、也没有
// 完成事件, Claude Code 表现为 query 静默停住。与 Responses 侧 stream_truncated 对齐。
// ---------------------------------------------------------------------------

test('AnthropicStreamConverter: 上游断流且无可见输出 -> 发 error 事件 (不再静默断流)', () => {
  const a = new c.AnthropicStreamConverter();
  const out = drive(a, [
    JSON.stringify({ id: 'chatcmpl_t', model: 'm',
      choices: [{ delta: { role: 'assistant' } }] })
  ]); // 既没有 finish_reason 也没有 [DONE]
  // 零 delta 流: message_start 被延迟且永远不会发, 只有 error 事件
  assert.deepStrictEqual(eventTypes(out), ['error']);
  assert.ok(out.includes('stream_truncated'));
  assert.ok(!out.includes('message_stop'));
  assert.strictEqual(a.sawRealDelta, false); // 网关据此判定可透明重试
});

test('AnthropicStreamConverter: 上游断流但已出正文 -> 按 max_tokens 收尾 (客户端可续写)', () => {
  const a = new c.AnthropicStreamConverter();
  const out = drive(a, [
    JSON.stringify({ choices: [{ delta: { content: '写了一半' } }] })
  ]);
  assert.deepStrictEqual(eventTypes(out), ['message_start', 'content_block_start',
    'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  assert.strictEqual(anthropicText(out), '写了一半'); // 断流前的输出保住了
  const md = frames(out).find((f) => f.event === 'message_delta');
  assert.strictEqual(md.data.delta.stop_reason, 'max_tokens');
});

test('AnthropicStreamConverter: 上游断流在工具调用中途 -> 闭合已开的 tool_use 块', () => {
  const a = new c.AnthropicStreamConverter();
  const out = drive(a, [
    JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1',
      type: 'function', function: { name: 'bash', arguments: '{"cmd":' } }] } }] })
  ]);
  // 已 start 的 tool_use 块必须补 content_block_stop, 不能留残缺事件序列
  assert.deepStrictEqual(eventTypes(out), ['message_start', 'content_block_start',
    'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
  const md = frames(out).find((f) => f.event === 'message_delta');
  assert.strictEqual(md.data.delta.stop_reason, 'max_tokens');
});

test('AnthropicStreamConverter: 正常 [DONE] 收尾不受断流兜底影响', () => {
  const a = new c.AnthropicStreamConverter();
  const out = drive(a, emptyStream()); // 含 [DONE]
  assert.deepStrictEqual(eventTypes(out), ['message_start', 'content_block_start',
    'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']);
});

console.log(`\nALL ${passed} TESTS PASSED`);
