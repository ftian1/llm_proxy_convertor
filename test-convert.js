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
  // 顶层 system 与「中间位置」的 system 都原样保留; 只有末条归一为 user
  assert.deepStrictEqual(chat.messages.map((m) => m.role),
    ['system', 'user', 'system', 'assistant', 'user', 'user']);
  // 内容逐字保留, 只动 role 字段
  assert.strictEqual(chat.messages[2].content, 'CLAUDE.md / env 上下文 (中间位置)');
  assert.strictEqual(chat.messages[5].content, notif[0].text);

  // 前缀 (末条之前) 与关闭开关时完全一致 -> 不影响前缀缓存
  const off = c.anthropicToOpenAI(body, { normalizeInlineSystem: false });
  assert.deepStrictEqual(off.messages.map((m) => m.role),
    ['system', 'user', 'system', 'assistant', 'user', 'system']);
  assert.deepStrictEqual(chat.messages.slice(0, 5), off.messages.slice(0, 5));
  assert.strictEqual(chat.messages[5].content, off.messages[5].content);

  // 末条不是 system 时不动任何东西
  const userTail = c.anthropicToOpenAI({
    model: 'm',
    messages: [{ role: 'user', content: 'hi' }, { role: 'system', content: 'mid' }, { role: 'user', content: 'tail' }],
  });
  assert.deepStrictEqual(userTail.messages.map((m) => m.role), ['user', 'system', 'user']);
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
  assert.deepStrictEqual(eventTypes(errOut), ['message_start', 'error']);
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
  const a = new c.AnthropicStreamConverter();
  const out = drive(a, [
    JSON.stringify({ choices: [{ delta: { reasoning_content: '想一下' } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    '[DONE]',
  ]);
  assert.ok(out.includes('thinking_delta'));
  assert.ok(out.includes('signature_delta'));
  assert.ok(out.includes('上游返回了空响应'));
  assert.strictEqual(a.emptyResponseDetected, true);
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
  // 只有 reasoning -> 算空响应, 仍补文本
  const onlyReasoning = new c.ResponsesStreamConverter(new c.ToolContext());
  const ro = drive(onlyReasoning, [
    JSON.stringify({ choices: [{ delta: { reasoning_content: '想一下' } }] }),
    JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }),
    '[DONE]',
  ]);
  assert.ok(ro.includes('上游返回了空响应'));

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

console.log(`\nALL ${passed} TESTS PASSED`);
