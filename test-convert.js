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

console.log(`\nALL ${passed} TESTS PASSED`);
