#!/usr/bin/env node
/**
 * LLM 协议转换模块 —— 移植自 cc-switch (farion1231/cc-switch)
 * 参考文件: src-tauri/src/proxy/providers/{transform.rs, streaming.rs,
 *           transform_codex_chat.rs, streaming_codex_chat.rs,
 *           codex_responses_sse.rs, codex_chat_common.rs}
 *
 * 上游只支持 OpenAI Chat Completions 时, 把两种客户端协议转换为 chat 格式:
 *   - Anthropic Messages API (/v1/messages) <-> OpenAI Chat Completions
 *   - OpenAI Responses API   (/v1/responses) <-> OpenAI Chat Completions
 *
 * 请求方向: anthropicToOpenAI() / responsesToChatCompletions()
 * 响应方向: openaiToAnthropic() / AnthropicStreamConverter   (非流式/流式)
 *           chatCompletionToResponse() / ResponsesStreamConverter
 *
 * 零依赖, Node >= 18。流式转换器接口: push(data) 吃一条上游 SSE "data:" 载荷
 * (JSON 字符串或 "[DONE]"), 返回要写给客户端的完整 SSE 帧数组; flush() 在流
 * 结束时调用, 补发收尾事件。
 */
'use strict';

// ---------------------------------------------------------------------------
// 规范 JSON (canonical JSON): 递归按键排序、紧凑输出, 保证跨请求字节稳定
// (prompt cache 前缀复用依赖字节级一致)
// ---------------------------------------------------------------------------

function canonicalJsonString(value) {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJsonString).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys
      .map((k) => JSON.stringify(k) + ':' + canonicalJsonString(value[k]))
      .join(',') + '}';
  }
  return JSON.stringify(value);
}

// 可解析的 JSON 字符串 -> 规范 JSON 字符串; 否则原样返回
function canonicalizeJsonStringIfParseable(s) {
  const trimmed = s.trim();
  if (trimmed === '') return s;
  try {
    return canonicalJsonString(JSON.parse(trimmed));
  } catch {
    return s;
  }
}

// 工具调用 arguments 归一化: 空串强制为 "{}" (严格上游拒绝空 arguments)
function canonicalizeToolArgumentsStr(s) {
  if (s.trim() === '') return '{}';
  return canonicalizeJsonStringIfParseable(s);
}

function canonicalizeToolArguments(v) {
  if (v === undefined || v === null) return '{}';
  if (typeof v === 'string') return canonicalizeToolArgumentsStr(v);
  return canonicalJsonString(v);
}

// ---------------------------------------------------------------------------
// Anthropic 请求 -> Chat Completions 请求
// ---------------------------------------------------------------------------

const ANTHROPIC_BILLING_HEADER_PREFIX = 'x-anthropic-billing-header:';

// 去掉 system 文本开头 Claude Code 注入的 billing header 行
// (cch= 值每请求轮换, 保留会破坏前缀缓存; 只剥开头一次, 用户文本原样保留)
function stripLeadingAnthropicBillingHeader(text) {
  if (!text.startsWith(ANTHROPIC_BILLING_HEADER_PREFIX)) return text;
  const idx = text.search(/[\r\n]/);
  if (idx === -1) return '';
  let rest = text.slice(idx + 1);
  if (text[idx] === '\r' && text[idx + 1] === '\n') rest = rest.slice(1);
  rest = rest.replace(/^[\r\n]+/, '');
  return rest;
}

// OpenAI o 系列推理模型 (o1/o3/o4-mini…) 需要 max_completion_tokens
function isOpenaiOSeries(model) {
  return model.length > 1 && model[0] === 'o' && model[1] >= '0' && model[1] <= '9';
}

// 支持 reasoning_effort 的模型家族: o 系列 / GPT-5+ / xAI Grok Build
function supportsReasoningEffort(model) {
  const m = model.toLowerCase();
  if (isOpenaiOSeries(m)) return true;
  if (m.startsWith('gpt-')) {
    const c = m[4];
    if (c >= '5' && c <= '9') return true;
  }
  return m === 'grok-4.5' || m.startsWith('grok-4.5-') || m.startsWith('grok-build-');
}

// Anthropic thinking -> OpenAI reasoning_effort
// 优先级: output_config.effort (low/medium/high 1:1, max -> xhigh)
//         thinking.type+budget (adaptive -> xhigh; enabled 按预算分档)
function resolveReasoningEffort(body) {
  const effort = body && body.output_config && body.output_config.effort;
  if (typeof effort === 'string') {
    switch (effort) {
      case 'low': return 'low';
      case 'medium': return 'medium';
      case 'high': return 'high';
      case 'max': return 'xhigh';
      default: return undefined;
    }
  }
  const thinking = body && body.thinking;
  if (!thinking || typeof thinking !== 'object') return undefined;
  if (thinking.type === 'adaptive') return 'xhigh';
  if (thinking.type === 'enabled') {
    const b = thinking.budget_tokens;
    if (typeof b === 'number') {
      if (b < 4000) return 'low';
      if (b < 16000) return 'medium';
    }
    return 'high';
  }
  return undefined;
}

// 流式 chat 请求注入 stream_options.include_usage,
// 否则兼容上游默认不在 SSE 里吐 usage, token/成本/缓存全部漏记
function injectStreamIncludeUsage(result) {
  if (result.stream !== true) return;
  if (result.stream_options && typeof result.stream_options === 'object') {
    result.stream_options.include_usage = true;
  } else {
    result.stream_options = { include_usage: true };
  }
}

// Anthropic tool_choice -> Chat tool_choice
//   "any" / {"type":"any"}    -> "required"
//   {"type":"tool","name":X}  -> {"type":"function","function":{"name":X}}
function mapToolChoiceToChat(toolChoice) {
  if (typeof toolChoice === 'string') {
    return toolChoice === 'any' ? 'required' : toolChoice;
  }
  if (toolChoice && typeof toolChoice === 'object') {
    switch (toolChoice.type) {
      case 'any': return 'required';
      case 'auto': return 'auto';
      case 'none': return 'none';
      case 'tool':
        return { type: 'function', function: { name: toolChoice.name || '' } };
      default:
        return toolChoice;
    }
  }
  return toolChoice;
}

// 清理 JSON schema: 根节点补 object 类型, 移除 "format":"uri", 递归处理嵌套
function cleanSchema(schema, isRoot) {
  if (isRoot === undefined) isRoot = true;
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return schema;
  const out = {};
  for (const k of Object.keys(schema)) out[k] = schema[k];
  if (isRoot && out.type === undefined) {
    out.type = 'object';
    if (out.properties === undefined) out.properties = {};
  }
  if (out.format === 'uri') delete out.format;
  if (out.properties && typeof out.properties === 'object') {
    for (const k of Object.keys(out.properties)) {
      out.properties[k] = cleanSchema(out.properties[k], false);
    }
  }
  if (out.items !== undefined) out.items = cleanSchema(out.items, false);
  return out;
}

// ---------------------------------------------------------------------------
// 工具输出里的媒体块 (image/file/audio): Chat tool 消息是纯文本,
// 媒体块被提取后以合成 user 消息形式重新呈现 (cc-switch tool_media.rs)
// ---------------------------------------------------------------------------

const TOOL_RESULT_MEDIA_MOVED_MARKER =
  '[cc-switch: tool result media moved to the following user message]';
const WHOLE_DATA_URL_MIN_BYTES = 8 * 1024;

function isImageBase64DataUrl(s) {
  return /^data:image\/[a-z0-9.+-]+;base64,/i.test(s);
}

// 整串即一个图片 data URL (且足够大) 时视为媒体; 嵌在 HTML/SVG 里的不碰
function wholeStringImageDataUrl(s) {
  const t = s.trim();
  if (t.length < WHOLE_DATA_URL_MIN_BYTES || !isImageBase64DataUrl(t)) return null;
  return { type: 'image_url', image_url: { url: t } };
}

// Anthropic image block -> chat image_url part
function chatImagePartFromImageBlock(block) {
  const src = block && block.source;
  if (!src) return null;
  if (src.type === 'base64' && typeof src.data === 'string') {
    return {
      type: 'image_url',
      image_url: { url: `data:${src.media_type || 'image/png'};base64,${src.data}` }
    };
  }
  if (src.type === 'url' && typeof src.url === 'string') {
    return { type: 'image_url', image_url: { url: src.url } };
  }
  return null;
}

// Responses input_file -> chat file 载荷 (只带 file_id/file_data/filename)
function chatFileFromInputFile(part) {
  if (!part || (part.file_id === undefined && part.file_data === undefined)) return null;
  const file = {};
  for (const k of ['file_id', 'file_data', 'filename']) {
    if (part[k] !== undefined) file[k] = part[k];
  }
  return file;
}

// 识别一个工具媒体块并转成 chat user content part
function chatMediaPartFromToolPart(part) {
  if (!part || typeof part !== 'object') return null;
  if (part.type === 'image') return chatImagePartFromImageBlock(part);
  if (part.type === 'input_image') {
    const iu = part.image_url;
    if (iu === undefined) return null;
    return {
      type: 'image_url',
      image_url: typeof iu === 'string' ? { url: iu } : iu
    };
  }
  if (part.type === 'input_file') {
    const f = chatFileFromInputFile(part);
    return f ? { type: 'file', file: f } : null;
  }
  if (part.type === 'input_audio' && part.input_audio !== undefined) {
    return { type: 'input_audio', input_audio: part.input_audio };
  }
  return null;
}

// 从工具输出里提取媒体块, 原位置替换为标记文本
function extractMediaFromToolValue(value, mediaParts, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 32) return 0;
  if (typeof value === 'string') {
    const img = wholeStringImageDataUrl(value);
    if (img) {
      mediaParts.push(img);
      return 1; // 调用方负责替换字符串
    }
    return 0;
  }
  if (!Array.isArray(value)) return 0;
  let replaced = 0;
  for (let i = 0; i < value.length; i++) {
    const block = value[i];
    if (!block || typeof block !== 'object') {
      replaced += extractMediaFromToolValue(block, mediaParts, depth + 1);
      continue;
    }
    const part = chatMediaPartFromToolPart(block);
    if (part) {
      mediaParts.push(part);
      value[i] = { type: 'text', text: TOOL_RESULT_MEDIA_MOVED_MARKER };
      replaced++;
    }
  }
  return replaced;
}

// 工具输出媒体计划: { toolContent, mediaParts } 或 null (无媒体)
function planToolOutputMedia(content) {
  if (typeof content === 'string') {
    const img = wholeStringImageDataUrl(content);
    if (!img) return null;
    return { toolContent: TOOL_RESULT_MEDIA_MOVED_MARKER, mediaParts: [img] };
  }
  if (!Array.isArray(content)) return null;
  const work = content.slice();
  const mediaParts = [];
  if (extractMediaFromToolValue(work, mediaParts) === 0) return null;
  return { toolContent: canonicalJsonString(work), mediaParts };
}

function queueToolOutputMedia(pendingMedia, callId, mediaParts) {
  if (!mediaParts || mediaParts.length === 0) return;
  pendingMedia.push({
    type: 'text',
    text: `[cc-switch: media output of tool call ${callId}]`
  });
  pendingMedia.push(...mediaParts);
}

function flushPendingToolMedia(messages, pendingMedia) {
  if (pendingMedia.length === 0) return;
  messages.push({ role: 'user', content: pendingMedia.splice(0) });
}

// 工具输出 -> chat tool 消息 content (字符串): 无媒体时与旧表示逐字节一致
function toolOutputContent(content) {
  const plan = planToolOutputMedia(content);
  if (plan) return plan; // 调用方需 queue 媒体
  if (typeof content === 'string') return { text: content };
  if (content === undefined || content === null) return { text: '' };
  return { text: canonicalJsonString(content) };
}

// 单条 Anthropic 消息 -> 多条 chat 消息 (tool_result 拆成独立 tool 消息)
function convertMessageToOpenAI(role, content, opts) {
  const result = [];
  if (content === undefined || content === null) {
    result.push({ role, content: null });
    return result;
  }
  if (typeof content === 'string') {
    result.push({ role, content });
    return result;
  }
  if (!Array.isArray(content)) {
    result.push({ role, content });
    return result;
  }

  const contentParts = [];
  const toolCalls = [];
  const pendingMedia = [];
  const reasoningParts = [];

  for (const block of content) {
    const t = block && block.type;
    if (t === 'text') {
      if (typeof block.text === 'string') contentParts.push({ type: 'text', text: block.text });
    } else if (t === 'image') {
      const part = chatImagePartFromImageBlock(block);
      if (part) contentParts.push(part);
    } else if (t === 'tool_use') {
      toolCalls.push({
        id: block.id || '',
        type: 'function',
        function: {
          name: block.name || '',
          arguments: canonicalJsonString(block.input === undefined ? {} : block.input)
        }
      });
    } else if (t === 'tool_result') {
      // tool_result 变成单独的 tool role 消息
      const toolUseId = block.tool_use_id || '';
      const plan = planToolOutputMedia(block.content);
      let toolContent;
      if (plan) {
        queueToolOutputMedia(pendingMedia, toolUseId, plan.mediaParts);
        toolContent = plan.toolContent;
      } else if (typeof block.content === 'string') {
        toolContent = block.content;
      } else if (block.content === undefined || block.content === null) {
        toolContent = '';
      } else {
        toolContent = canonicalJsonString(block.content);
      }
      result.push({ role: 'tool', tool_call_id: toolUseId, content: toolContent });
    } else if (t === 'thinking') {
      if (typeof block.thinking === 'string' && block.thinking !== '') {
        reasoningParts.push(block.thinking);
      }
    } else if (t === 'redacted_thinking' && opts.attachReasoning) {
      reasoningParts.push('[redacted thinking]');
    }
  }

  // chat tool 消息不能带图片, 提取出的媒体合成一条 user 消息
  flushPendingToolMedia(result, pendingMedia);

  if (contentParts.length > 0 || toolCalls.length > 0) {
    const msg = { role };
    if (contentParts.length === 0) {
      msg.content = null;
    } else if (contentParts.length === 1 && contentParts[0].type === 'text') {
      msg.content = contentParts[0].text; // 单 text block 简化为纯字符串
    } else {
      msg.content = contentParts;
    }
    if (toolCalls.length > 0) {
      msg.tool_calls = toolCalls;
      if (opts.attachReasoning && role === 'assistant') {
        msg.reasoning_content = reasoningParts.length > 0
          ? reasoningParts.join('\n')
          : 'tool call';
      }
    }
    result.push(msg);
  }

  return result;
}

/**
 * Anthropic Messages 请求 -> Chat Completions 请求
 * 对应 cc-switch transform.rs::anthropic_to_openai_with_reasoning_content
 */
function anthropicToOpenAI(body, opts = {}) {
  const result = {};
  if (body.model !== undefined) result.model = body.model;

  const messages = [];
  // 顶层 system -> 一条 system 消息 (跨轮字节稳定, 不影响前缀缓存)
  if (typeof body.system === 'string') {
    const t = stripLeadingAnthropicBillingHeader(body.system);
    if (t !== '') messages.push({ role: 'system', content: t });
  } else if (Array.isArray(body.system)) {
    const parts = [];
    for (const m of body.system) {
      if (m && typeof m.text === 'string') {
        const t = stripLeadingAnthropicBillingHeader(m.text);
        if (t !== '') parts.push(t);
      }
    }
    if (parts.length > 0) messages.push({ role: 'system', content: parts.join('\n') });
  }

  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      const role = (msg && msg.role) || 'user';
      messages.push(...convertMessageToOpenAI(role, msg && msg.content, opts));
    }
  }
  result.messages = messages;

  const model = body.model || '';
  if (body.max_tokens !== undefined) {
    // o 系列模型需要 max_completion_tokens
    if (isOpenaiOSeries(model)) result.max_completion_tokens = body.max_tokens;
    else result.max_tokens = body.max_tokens;
  }
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;
  if (body.stop_sequences !== undefined) result.stop = body.stop_sequences;
  if (body.stream !== undefined) result.stream = body.stream;

  if (supportsReasoningEffort(model)) {
    const effort = resolveReasoningEffort(body);
    if (effort !== undefined) result.reasoning_effort = effort;
  }

  // tools (过滤 BatchTool)
  if (Array.isArray(body.tools)) {
    const tools = body.tools
      .filter((t) => t && t.type !== 'BatchTool')
      .map((t) => ({
        type: 'function',
        function: {
          name: t.name || '',
          description: t.description === undefined ? null : t.description,
          parameters: cleanSchema(t.input_schema === undefined ? {} : t.input_schema)
        }
      }));
    if (tools.length > 0) result.tools = tools;
  }
  if (body.tool_choice !== undefined) result.tool_choice = mapToolChoiceToChat(body.tool_choice);

  injectStreamIncludeUsage(result);
  return result;
}

// ---------------------------------------------------------------------------
// Chat Completions 响应 -> Anthropic 响应 (非流式)
// ---------------------------------------------------------------------------

function buildAnthropicUsageJson(usage) {
  // OpenAI prompt_tokens 含缓存, Anthropic input_tokens 不含:
  // input + cache_read + cache_creation == prompt_tokens (三桶互斥)
  const cached = usage.cache_read_input_tokens
    ?? usage.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheCreation = usage.cache_creation_input_tokens
    ?? usage.prompt_tokens_details?.cache_write_tokens
    ?? usage.input_tokens_details?.cache_write_tokens ?? 0;
  const input = Math.max(0, (usage.prompt_tokens || 0) - cached - cacheCreation);
  const out = {
    input_tokens: input,
    output_tokens: usage.completion_tokens || 0
  };
  if (cached > 0) out.cache_read_input_tokens = cached;
  if (cacheCreation > 0) out.cache_creation_input_tokens = cacheCreation;
  return out;
}

function mapStopReason(finishReason) {
  switch (finishReason) {
    case 'tool_calls':
    case 'function_call': return 'tool_use';
    case 'stop': return 'end_turn';
    case 'length': return 'max_tokens';
    default: return 'end_turn';
  }
}

/**
 * Chat Completions 响应 -> Anthropic Messages 响应 (非流式)
 * 对应 cc-switch transform.rs::openai_to_anthropic
 */
function openaiToAnthropic(body) {
  const choices = body && body.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('No choices in response');
  }
  const choice = choices[0];
  const message = choice.message;
  if (!message) throw new Error('No message in choice');

  const content = [];
  let hasToolUse = false;

  // DeepSeek 等 provider 把思考内容放在 message.reasoning_content
  if (typeof message.reasoning_content === 'string' && message.reasoning_content !== '') {
    content.push({ type: 'thinking', thinking: message.reasoning_content });
  }

  if (typeof message.content === 'string') {
    if (message.content !== '') content.push({ type: 'text', text: message.content });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if ((part.type === 'text' || part.type === 'output_text')
          && typeof part.text === 'string' && part.text !== '') {
        content.push({ type: 'text', text: part.text });
      } else if (part.type === 'refusal' && typeof part.refusal === 'string' && part.refusal !== '') {
        content.push({ type: 'text', text: part.refusal });
      }
    }
  }
  if (typeof message.refusal === 'string' && message.refusal !== '') {
    content.push({ type: 'text', text: message.refusal });
  }

  if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
    hasToolUse = true;
    for (const tc of message.tool_calls) {
      const fn = tc.function || {};
      let input = {};
      try { input = JSON.parse(fn.arguments || '{}'); } catch { input = {}; }
      content.push({
        type: 'tool_use',
        id: tc.id || '',
        name: fn.name || '',
        input
      });
    }
  }
  // 兼容旧格式 function_call
  if (!hasToolUse && message.function_call) {
    const fc = message.function_call;
    let input = {};
    if (typeof fc.arguments === 'string') {
      try { input = JSON.parse(fc.arguments); } catch { input = {}; }
    } else if (typeof fc.arguments === 'object') {
      input = fc.arguments;
    }
    if (fc.name || fc.arguments !== undefined) {
      content.push({
        type: 'tool_use',
        id: fc.id || '',
        name: fc.name || '',
        input
      });
    }
  }

  const stopReason = mapStopReason(choice.finish_reason);
  const usage = buildAnthropicUsageJson(body.usage || {});

  return {
    id: body.id || '',
    type: 'message',
    role: 'assistant',
    content,
    model: body.model || '',
    stop_reason: stopReason,
    stop_sequence: null,
    usage
  };
}

// chat 错误体 -> Anthropic 错误体
function chatErrorToAnthropicError(body) {
  let message = 'upstream error';
  let type = 'api_error';
  if (body && typeof body === 'object') {
    const e = body.error || body;
    if (typeof e === 'string') message = e;
    else {
      message = e.message || e.detail || message;
      type = e.type || type;
    }
  } else if (typeof body === 'string' && body !== '') {
    message = body;
  }
  return { type: 'error', error: { type, message } };
}

// ---------------------------------------------------------------------------
// Chat SSE -> Anthropic SSE (流式)
// 对应 cc-switch streaming.rs::create_anthropic_sse_stream
// ---------------------------------------------------------------------------

class AnthropicStreamConverter {
  constructor() {
    this.messageId = null;
    this.currentModel = null;
    this.nextContentIndex = 0;
    this.hasSentMessageStart = false;
    // 上游可能发多个带 finish_reason 的 chunk; Anthropic 协议一个流只允许一个
    // message_delta, 且缓存到 [DONE] 再发以保证 usage 完整
    this.hasEmittedMessageDelta = false;
    this.pendingMessageDelta = null; // { stopReason, usage }
    this.hasSentMessageStop = false;
    this.latestUsage = null;
    this.currentNonToolBlockType = null; // 'text' | 'thinking'
    this.currentNonToolBlockIndex = null;
    this.toolBlocks = new Map(); // chat index -> 状态
    this.openToolBlockIndices = new Set();
  }

  frame(event, obj) {
    return `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;
  }

  // 关闭当前非工具块 (切块/收尾时调用)
  stopNonToolBlock() {
    const out = [];
    if (this.currentNonToolBlockIndex !== null) {
      out.push(this.frame('content_block_stop', {
        type: 'content_block_stop',
        index: this.currentNonToolBlockIndex
      }));
    }
    this.currentNonToolBlockType = null;
    this.currentNonToolBlockIndex = null;
    return out;
  }

  // 输入一条上游 SSE "data:" 载荷 (JSON 字符串或 "[DONE]"), 返回出站帧
  push(data) {
    const out = [];
    if (data.trim() === '[DONE]') {
      // 流正常结束: 发出缓存的 message_delta (含完整 usage) + message_stop
      if (this.pendingMessageDelta) {
        out.push(this.frame('message_delta', {
          type: 'message_delta',
          delta: {
            stop_reason: this.pendingMessageDelta.stopReason,
            stop_sequence: null
          },
          usage: this.pendingMessageDelta.usage || { input_tokens: 0, output_tokens: 0 }
        }));
        this.pendingMessageDelta = null;
      }
      if (!this.hasSentMessageStop) {
        out.push(this.frame('message_stop', { type: 'message_stop' }));
        this.hasSentMessageStop = true;
      }
      return out;
    }

    let chunk;
    try { chunk = JSON.parse(data); } catch { return out; }
    // 上游错误 chunk (Azure 等以 SSE error 事件发错): 转成 Anthropic error 事件
    // (比 Rust 原版多一步: 网关场景需要把上游错误如实报给客户端)
    if (chunk && chunk.error !== undefined) {
      const e = chunk.error;
      const message = typeof e === 'string' ? e
        : (e && (e.message || e.detail)) || JSON.stringify(chunk);
      const type = (e && typeof e === 'object' && e.type) || 'api_error';
      out.push(this.frame('error', { type: 'error', error: { type, message } }));
      return out;
    }
    if (chunk.id && !this.messageId) this.messageId = chunk.id;
    if (chunk.model && !this.currentModel) this.currentModel = chunk.model;

    const chunkUsage = chunk.usage ? buildAnthropicUsageJson(chunk.usage) : null;
    if (chunkUsage) {
      this.latestUsage = chunkUsage;
      if (this.pendingMessageDelta) this.pendingMessageDelta.usage = chunkUsage;
    }

    const choice = (chunk.choices || [])[0];
    if (!choice) return out;

    if (!this.hasSentMessageStart) {
      out.push(this.frame('message_start', {
        type: 'message_start',
        message: {
          id: this.messageId || '',
          type: 'message',
          role: 'assistant',
          model: this.currentModel || '',
          usage: chunkUsage || { input_tokens: 0, output_tokens: 0 }
        }
      }));
      this.hasSentMessageStart = true;
    }

    const delta = choice.delta || {};

    // reasoning (OpenRouter/Kimi 用 reasoning, DeepSeek 用 reasoning_content)
    const reasoning = delta.reasoning !== undefined ? delta.reasoning : delta.reasoning_content;
    if (typeof reasoning === 'string' && reasoning !== '') {
      if (this.currentNonToolBlockType !== 'thinking') {
        out.push(...this.stopNonToolBlock());
        const index = this.nextContentIndex++;
        out.push(this.frame('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'thinking', thinking: '' }
        }));
        this.currentNonToolBlockType = 'thinking';
        this.currentNonToolBlockIndex = index;
      }
      out.push(this.frame('content_block_delta', {
        type: 'content_block_delta',
        index: this.currentNonToolBlockIndex,
        delta: { type: 'thinking_delta', thinking: reasoning }
      }));
    }

    // 文本内容
    if (typeof delta.content === 'string' && delta.content !== '') {
      if (this.currentNonToolBlockType !== 'text') {
        out.push(...this.stopNonToolBlock());
        const index = this.nextContentIndex++;
        out.push(this.frame('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' }
        }));
        this.currentNonToolBlockType = 'text';
        this.currentNonToolBlockIndex = index;
      }
      out.push(this.frame('content_block_delta', {
        type: 'content_block_delta',
        index: this.currentNonToolBlockIndex,
        delta: { type: 'text_delta', text: delta.content }
      }));
    }

    // 工具调用 (按 chat index 路由, 支持并行调用乱序到达)
    if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
      out.push(...this.stopNonToolBlock());
      for (const tc of delta.tool_calls) {
        let state = this.toolBlocks.get(tc.index);
        if (!state) {
          state = {
            anthropicIndex: this.nextContentIndex++,
            id: '',
            name: '',
            started: false,
            pendingArgs: ''
          };
          this.toolBlocks.set(tc.index, state);
        }
        if (tc.id) state.id = tc.id;
        const fn = tc.function || {};
        if (fn.name) state.name = fn.name;

        // id 和 name 齐了才 content_block_start; 先到的 arguments 先缓存
        const shouldStart = !state.started && state.id !== '' && state.name !== '';
        if (shouldStart) state.started = true;
        let pendingAfterStart = '';
        if (shouldStart && state.pendingArgs !== '') {
          pendingAfterStart = state.pendingArgs;
          state.pendingArgs = '';
        }
        const argsDelta = fn.arguments;
        let immediateDelta = '';
        if (typeof argsDelta === 'string' && argsDelta !== '') {
          if (state.started) immediateDelta = argsDelta;
          else state.pendingArgs += argsDelta;
        }

        if (shouldStart) {
          out.push(this.frame('content_block_start', {
            type: 'content_block_start',
            index: state.anthropicIndex,
            content_block: { type: 'tool_use', id: state.id, name: state.name }
          }));
          this.openToolBlockIndices.add(state.anthropicIndex);
        }
        if (pendingAfterStart !== '') {
          out.push(this.frame('content_block_delta', {
            type: 'content_block_delta',
            index: state.anthropicIndex,
            delta: { type: 'input_json_delta', partial_json: pendingAfterStart }
          }));
        }
        if (immediateDelta !== '') {
          out.push(this.frame('content_block_delta', {
            type: 'content_block_delta',
            index: state.anthropicIndex,
            delta: { type: 'input_json_delta', partial_json: immediateDelta }
          }));
        }
      }
    }

    // finish_reason: 只缓存 message_delta, 等 [DONE] 统一发出 (保证 usage 完整且只发一次)
    if (choice.finish_reason) {
      const stopReason = mapStopReason(choice.finish_reason);
      if (!this.hasEmittedMessageDelta) {
        this.hasEmittedMessageDelta = true;
        out.push(...this.stopNonToolBlock());

        // 迟到的块: arguments 先于 id/name 到达, 此时补 start
        const lateStarts = [];
        for (const [chatIdx, st] of this.toolBlocks) {
          if (st.started) continue;
          const hasPayload = st.pendingArgs !== '' || st.id !== '' || st.name !== '';
          if (!hasPayload) continue;
          st.started = true;
          const fallbackId = st.id !== '' ? st.id : `tool_call_${chatIdx}`;
          const fallbackName = st.name !== '' ? st.name : 'unknown_tool';
          const pending = st.pendingArgs;
          st.pendingArgs = '';
          lateStarts.push([st.anthropicIndex, fallbackId, fallbackName, pending]);
        }
        lateStarts.sort((a, b) => a[0] - b[0]);
        for (const [index, id, name, pending] of lateStarts) {
          out.push(this.frame('content_block_start', {
            type: 'content_block_start',
            index,
            content_block: { type: 'tool_use', id, name }
          }));
          this.openToolBlockIndices.add(index);
          if (pending !== '') {
            out.push(this.frame('content_block_delta', {
              type: 'content_block_delta',
              index,
              delta: { type: 'input_json_delta', partial_json: pending }
            }));
          }
        }

        if (this.openToolBlockIndices.size > 0) {
          const sorted = [...this.openToolBlockIndices].sort((a, b) => a - b);
          for (const index of sorted) {
            out.push(this.frame('content_block_stop', { type: 'content_block_stop', index }));
          }
          this.openToolBlockIndices.clear();
        }

        this.pendingMessageDelta = {
          stopReason,
          usage: chunkUsage || this.latestUsage
        };
      }
    }

    return out;
  }

  // 流结束但没收到 [DONE]: 补发缓存的 message_delta 和 message_stop
  flush() {
    const out = [];
    let emitted = false;
    if (this.pendingMessageDelta) {
      out.push(this.frame('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: this.pendingMessageDelta.stopReason,
          stop_sequence: null
        },
        usage: this.pendingMessageDelta.usage || { input_tokens: 0, output_tokens: 0 }
      }));
      this.pendingMessageDelta = null;
      emitted = true;
    }
    if (emitted && !this.hasSentMessageStop) {
      out.push(this.frame('message_stop', { type: 'message_stop' }));
      this.hasSentMessageStop = true;
    }
    return out;
  }

  // 上游流中断
  error(message) {
    return [this.frame('error', {
      type: 'error',
      error: { type: 'stream_error', message }
    })];
  }
}

// ---------------------------------------------------------------------------
// Responses 请求 -> Chat Completions 请求
// ---------------------------------------------------------------------------

const EXTRA_CHAT_PASSTHROUGH_FIELDS = [
  'frequency_penalty', 'logit_bias', 'logprobs', 'metadata', 'n',
  'parallel_tool_calls', 'presence_penalty', 'response_format', 'seed',
  'service_tier', 'stop', 'stream_options', 'top_logprobs', 'user'
];

const TOOL_SEARCH_PROXY_NAME = 'tool_search';
const CUSTOM_TOOL_INPUT_FIELD = 'input';
const CUSTOM_TOOL_PRESERVED_METADATA_HEADING = 'Original tool definition:';
const CUSTOM_TOOL_INPUT_DESCRIPTION =
  'Raw string input for the original custom tool. Preserve formatting exactly ' +
  'and follow the original tool definition embedded in the description.';

// Responses 工具名 -> chat 工具名 (namespace 工具压平为 ns__name);
// 同时记录映射, 响应方向还原 Codex 的 function_call/custom_tool_call/tool_search_call
class ToolContext {
  constructor() {
    this.chatTools = [];
    this.chatNameToSpec = new Map(); // chatName -> {kind, name, namespace}
    this.namespaceNameToChatName = new Map(); // namespace + '\x00' + name -> chatName
    this.seenChatNames = new Set();
  }

  addChatTool(chatName, spec, chatTool) {
    if (chatName.trim() === '' || this.seenChatNames.has(chatName)) return;
    this.seenChatNames.add(chatName);
    if (spec.namespace) {
      this.namespaceNameToChatName.set(`${spec.namespace}\x00${spec.name}`, chatName);
    }
    this.chatNameToSpec.set(chatName, spec);
    this.chatTools.push(chatTool);
  }

  responsesToolName(tool) {
    const name = (tool.function && tool.function.name) || tool.name;
    if (typeof name !== 'string') return null;
    const t = name.trim();
    return t === '' ? null : t;
  }

  addFunctionTool(tool, namespace) {
    const originalName = this.responsesToolName(tool);
    if (!originalName) return;
    const chatName = namespace ? `${namespace}__${originalName}` : originalName;
    const chatTool = responsesFunctionToolToChatTool(tool, chatName);
    if (!chatTool) return;
    this.addChatTool(chatName, {
      kind: namespace ? 'namespace' : 'function',
      name: originalName,
      namespace: namespace || null
    }, chatTool);
  }

  addCustomTool(tool) {
    const name = this.responsesToolName(tool);
    if (!name) return;
    const chatTool = {
      type: 'function',
      function: {
        name,
        description: CUSTOM_TOOL_PRESERVED_METADATA_HEADING + '\n```json\n'
          + canonicalJsonString(tool) + '\n```',
        parameters: {
          type: 'object',
          properties: {
            [CUSTOM_TOOL_INPUT_FIELD]: {
              type: 'string',
              description: CUSTOM_TOOL_INPUT_DESCRIPTION
            }
          },
          required: [CUSTOM_TOOL_INPUT_FIELD]
        }
      }
    };
    this.addChatTool(name, { kind: 'custom', name, namespace: null }, chatTool);
  }

  addToolSearchTool() {
    const chatTool = {
      type: 'function',
      function: {
        name: TOOL_SEARCH_PROXY_NAME,
        description: 'Search and load Codex tools, plugins, connectors, and MCP namespaces for the current task.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: 'Search query for tools or connectors to load.' },
            limit: { type: 'integer', description: 'Maximum number of tool groups to return.' }
          },
          required: ['query']
        }
      }
    };
    this.addChatTool(TOOL_SEARCH_PROXY_NAME, {
      kind: 'toolSearch', name: TOOL_SEARCH_PROXY_NAME, namespace: null
    }, chatTool);
  }

  addNamespaceTool(tool) {
    const namespace = tool.name;
    if (typeof namespace !== 'string') return;
    const children = tool.tools || tool.children;
    if (!Array.isArray(children)) return;
    for (const child of children) {
      if (child && child.type === 'function') this.addFunctionTool(child, namespace);
    }
  }

  addResponseTool(tool) {
    if (typeof tool === 'string') {
      this.addCustomTool({ type: 'custom', name: tool });
      return;
    }
    if (!tool || typeof tool !== 'object') return;
    switch (tool.type) {
      case 'function': this.addFunctionTool(tool, null); break;
      case 'custom': this.addCustomTool(tool); break;
      case 'tool_search': this.addToolSearchTool(); break;
      case 'namespace': this.addNamespaceTool(tool); break;
    }
  }

  lookup(chatName) { return this.chatNameToSpec.get(chatName); }
  isCustom(chatName) {
    const spec = this.lookup(chatName);
    return !!spec && spec.kind === 'custom';
  }

  // 响应方向: chat 名还原成 Responses 名 (namespace 压平名还原)
  chatNameForResponseFunction(name, namespace) {
    if (namespace) {
      const known = this.namespaceNameToChatName.get(`${namespace}\x00${name}`);
      if (known) return known;
      return `${namespace}__${name}`;
    }
    return name;
  }

  // 从请求构建: tools + input 里 tool_search_output 携带的工具
  buildFromRequest(body) {
    if (Array.isArray(body.tools)) {
      for (const tool of body.tools) this.addResponseTool(tool);
    }
    collectToolSearchOutputTools(body.input, this);
  }
}

function collectToolSearchOutputTools(value, context) {
  if (Array.isArray(value)) {
    for (const item of value) collectToolSearchOutputTools(item, context);
  } else if (value && typeof value === 'object') {
    if (value.type === 'tool_search_output' && Array.isArray(value.tools)) {
      for (const tool of value.tools) context.addResponseTool(tool);
    }
    for (const v of Object.values(value)) collectToolSearchOutputTools(v, context);
  }
}

// Responses function tool -> chat function tool (parameters.type 强制 object)
function normalizeFunctionParameters(params) {
  let p;
  if (params && typeof params === 'object' && !Array.isArray(params)) p = { ...params };
  else p = { type: 'object', properties: {} };
  if (p.type !== 'object') p.type = 'object';
  return p;
}

function responsesFunctionToolToChatTool(tool, chatName) {
  if (!tool || tool.type !== 'function') return null;
  if (tool.function) {
    const fn = { ...tool.function, name: chatName };
    fn.parameters = normalizeFunctionParameters(fn.parameters);
    if (tool.strict !== undefined && fn.strict === undefined) fn.strict = tool.strict;
    return { type: 'function', function: fn };
  }
  const fn = {
    name: chatName,
    description: tool.description === undefined ? null : tool.description,
    parameters: normalizeFunctionParameters(tool.parameters)
  };
  if (tool.strict !== undefined) fn.strict = tool.strict;
  return { type: 'function', function: fn };
}

// Responses tool_choice -> chat tool_choice (压平名)
function responsesToolChoiceToChat(toolChoice, toolContext) {
  if (toolChoice && typeof toolChoice === 'object') {
    if (toolChoice.type === 'function') {
      const name = toolContext.chatNameForResponseFunction(
        toolChoice.name || '', toolChoice.namespace);
      return { type: 'function', function: { name } };
    }
    if (toolChoice.type === 'tool_search') {
      return { type: 'function', function: { name: TOOL_SEARCH_PROXY_NAME } };
    }
    if (toolChoice.type === 'custom') {
      return { type: 'function', function: { name: toolChoice.name || '' } };
    }
  }
  return toolChoice;
}

// responses role -> chat role
function responsesRoleToChatRole(role) {
  switch (role) {
    case 'system':
    case 'developer': return 'system';
    case 'assistant': return 'assistant';
    case 'tool': return 'tool';
    default: return 'user'; // user / latest_reminder / 未知
  }
}

// responses content parts -> chat content (纯文本合并为字符串)
function responsesContentToChatContent(parts) {
  if (typeof parts === 'string' || parts === null || parts === undefined) return parts;
  if (!Array.isArray(parts)) return parts;
  const chatParts = [];
  let hasNonTextPart = false;
  for (const part of parts) {
    const t = part && part.type;
    if (t === 'input_text' || t === 'output_text' || t === 'text') {
      if (typeof part.text === 'string' && part.text !== '') {
        chatParts.push({ type: 'text', text: part.text });
      }
    } else if (t === 'refusal') {
      if (typeof part.refusal === 'string' && part.refusal !== '') {
        chatParts.push({ type: 'text', text: part.refusal });
      }
    } else if (t === 'input_image' && part.image_url !== undefined) {
      chatParts.push({
        type: 'image_url',
        image_url: typeof part.image_url === 'string' ? { url: part.image_url } : part.image_url
      });
      hasNonTextPart = true;
    } else if (t === 'input_file') {
      const f = chatFileFromInputFile(part);
      if (f) {
        chatParts.push({ type: 'file', file: f });
        hasNonTextPart = true;
      }
    } else if (t === 'input_audio' && part.input_audio !== undefined) {
      chatParts.push({ type: 'input_audio', input_audio: part.input_audio });
      hasNonTextPart = true;
    }
  }
  if (!hasNonTextPart) return chatParts.map((p) => p.text).join('\n');
  return chatParts;
}

// reasoning 提取: reasoning_content > reasoning (字符串/对象) > reasoning_details
function extractReasoningFieldText(value) {
  if (!value || typeof value !== 'object') return null;
  for (const key of ['reasoning_content', 'reasoning']) {
    const v = value[key];
    if (typeof v === 'string' && v !== '') return v;
  }
  if (value.reasoning && typeof value.reasoning === 'object') {
    for (const key of ['content', 'text', 'summary']) {
      const v = value.reasoning[key];
      if (typeof v === 'string' && v !== '') return v;
    }
  }
  const details = value.reasoning_details;
  if (details !== undefined) {
    const extract = (d) => {
      if (typeof d === 'string') return d;
      if (Array.isArray(d)) return d.map(extract).filter((s) => s !== '').join('\n\n');
      if (d && typeof d === 'object') {
        for (const key of ['text', 'content', 'summary']) {
          if (typeof d[key] === 'string' && d[key] !== '') return d[key];
        }
        if (Array.isArray(d.parts)) {
          const t = d.parts.map(extract).filter((s) => s !== '').join('\n\n');
          if (t !== '') return t;
        }
      }
      return '';
    };
    const t = extract(details);
    if (t !== '') return t;
  }
  return null;
}

// reasoning item 的 summary 文本
function extractReasoningSummaryText(item) {
  for (const key of ['reasoning_content', 'content', 'text']) {
    const v = item && item[key];
    if (typeof v === 'string' && v !== '') return v;
  }
  const summary = item && item.summary;
  if (typeof summary === 'string') return summary === '' ? null : summary;
  if (Array.isArray(summary)) {
    const t = summary
      .map((p) => (typeof p === 'string' ? p : (p && (p.text || p.content))))
      .filter((s) => typeof s === 'string' && s !== '')
      .join('\n\n');
    return t === '' ? null : t;
  }
  return null;
}

function appendPendingReasoning(pending, reasoning, unique) {
  const r = (reasoning || '').trim();
  if (r === '') return;
  if (pending.current === undefined || pending.current === '') {
    pending.current = r;
  } else if (!(unique && pending.current.includes(r))) {
    pending.current += '\n\n' + r;
  }
}

// 把 pending reasoning 附挂到 assistant 消息的 reasoning_content (仅思考型上游开启)
function attachPendingReasoningToAssistant(msg, pending) {
  if (pending.current === undefined || pending.current.trim() === '') return;
  const r = pending.current;
  pending.current = undefined;
  if (typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim() !== '') {
    msg.reasoning_content += '\n\n' + r;
  } else {
    msg.reasoning_content = r;
  }
}

// 所有 input 处理完毕后, 仍缺 reasoning_content 的 assistant tool-call 消息补占位
// (kimi/DeepSeek 等要求带 tool_calls 的 assistant 消息必须有非空 reasoning_content)
function backfillToolCallReasoningPlaceholders(messages) {
  for (const msg of messages) {
    const isAssistantToolCall = msg.role === 'assistant'
      && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
    if (!isAssistantToolCall) continue;
    if (!(typeof msg.reasoning_content === 'string' && msg.reasoning_content.trim() !== '')) {
      msg.reasoning_content = 'tool call';
    }
  }
}

function responsesFunctionCallToChatToolCall(item) {
  return {
    id: item.call_id || item.id || '',
    type: 'function',
    function: {
      name: item.name || '',
      arguments: canonicalizeToolArguments(item.arguments)
    }
  };
}

function responsesCustomToolCallToChatToolCall(item) {
  return {
    id: item.call_id || item.id || '',
    type: 'function',
    function: {
      name: item.name || '',
      arguments: canonicalJsonString({ [CUSTOM_TOOL_INPUT_FIELD]: item.input === undefined ? '' : item.input })
    }
  };
}

function responsesToolSearchCallToChatToolCall(item) {
  return {
    id: item.call_id || item.id || '',
    type: 'function',
    function: {
      name: TOOL_SEARCH_PROXY_NAME,
      arguments: item.arguments === undefined ? '{}' : canonicalJsonString(item.arguments)
    }
  };
}

// 只有 system 消息且 MiniMax 等要求 system 只能出现在首位: 合并到消息头
function collapseSystemMessagesToHead(messages) {
  const systemChunks = [];
  const rest = [];
  for (const msg of messages) {
    if (msg.role === 'system' && typeof msg.content === 'string') {
      if (msg.content.trim() !== '') systemChunks.push(msg.content);
      continue;
    }
    rest.push(msg);
  }
  if (systemChunks.length === 0) return rest;
  return [{ role: 'system', content: systemChunks.join('\n\n') }, ...rest];
}

function instructionText(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((p) => (typeof p === 'string' ? p : p && p.text))
      .filter((s) => typeof s === 'string' && s !== '')
      .join('\n\n');
  }
  return typeof value === 'string' ? value : '';
}

// input 数组 -> chat 消息序列 (function_call 攒批成 assistant tool_calls 消息,
// reasoning 前向附挂到其后的 assistant, 回合边界回溯附挂)
function appendResponsesInput(input, opts) {
  const messages = [];
  const state = {
    pendingToolCalls: [],
    pendingMedia: [],
    pendingReasoning: { current: undefined },
    lastAssistantIndex: null
  };
  const attach = opts.attachReasoning;

  const flushToolCalls = () => {
    if (state.pendingToolCalls.length === 0) return;
    flushPendingToolMedia(messages, state.pendingMedia);
    const msg = {
      role: 'assistant',
      content: null,
      tool_calls: state.pendingToolCalls.splice(0)
    };
    if (attach) attachPendingReasoningToAssistant(msg, state.pendingReasoning);
    state.lastAssistantIndex = messages.length;
    messages.push(msg);
  };

  const updateLastAssistantIndex = (msg) => {
    if (msg.role === 'assistant') state.lastAssistantIndex = messages.length;
    else if (msg.role === 'tool') { /* 不改变 */ }
    else state.lastAssistantIndex = null;
  };

  const appendItem = (item) => {
    const t = item && item.type;
    if (t === 'function_call' || t === 'custom_tool_call' || t === 'tool_search_call') {
      if (attach) appendPendingReasoning(state.pendingReasoning, extractReasoningFieldText(item), true);
      const call = t === 'function_call' ? responsesFunctionCallToChatToolCall(item)
        : t === 'custom_tool_call' ? responsesCustomToolCallToChatToolCall(item)
          : responsesToolSearchCallToChatToolCall(item);
      // 压缩名已由 ToolContext 在响应方向还原, 请求方向 chat 名与 responses 名一致
      // (function_call 带 namespace 时需压平)
      if (t === 'function_call' && item.namespace) {
        call.function.name = `${item.namespace}__${item.name}`;
      }
      state.pendingToolCalls.push(call);
    } else if (t === 'function_call_output' || t === 'custom_tool_call_output' || t === 'tool_search_output') {
      flushToolCalls();
      const callId = item.call_id || '';
      let output;
      const plan = planToolOutputMedia(item.output);
      if (plan) {
        queueToolOutputMedia(state.pendingMedia, callId, plan.mediaParts);
        output = plan.toolContent;
      } else if (typeof item.output === 'string') {
        output = canonicalizeJsonStringIfParseable(item.output);
      } else if (item.output === undefined || item.output === null) {
        output = '';
      } else {
        output = canonicalJsonString(item.output);
      }
      messages.push({ role: 'tool', tool_call_id: callId, content: output });
    } else if (t === 'reasoning') {
      // reasoning 一律先进 pending, 前向附挂到其后的 message/function_call;
      // 真正的尾部剩余在 input 结束时回溯附挂
      if (attach) appendPendingReasoning(state.pendingReasoning, extractReasoningSummaryText(item), false);
    } else if (t === 'input_text' || t === 'input_image' || t === 'input_file' || t === 'input_audio') {
      flushToolCalls();
      flushPendingToolMedia(messages, state.pendingMedia);
      const role = responsesRoleToChatRole((item.role) || 'user');
      const msg = {
        role,
        content: responsesContentToChatContent([item])
      };
      if (role === 'assistant') {
        if (attach) attachPendingReasoningToAssistant(msg, state.pendingReasoning);
        updateLastAssistantIndex(msg);
        messages.push(msg);
        return;
      }
      // 非 assistant 回合边界: pending reasoning 回溯附挂到上一条 assistant
      if (attach && state.lastAssistantIndex !== null) {
        attachPendingReasoningToAssistant(messages[state.lastAssistantIndex], state.pendingReasoning);
      }
      updateLastAssistantIndex(msg);
      messages.push(msg);
    } else if (item && (item.role !== undefined || item.content !== undefined)) {
      // 普通 message item / 未知但含 role|content 的 item
      flushToolCalls();
      flushPendingToolMedia(messages, state.pendingMedia);
      const role = responsesRoleToChatRole(item.role || 'user');
      const msg = {
        role,
        content: item.content === undefined
          ? null
          : responsesContentToChatContent(item.content)
      };
      if (role === 'assistant') {
        if (attach) appendPendingReasoning(state.pendingReasoning, extractReasoningFieldText(item));
        if (attach) attachPendingReasoningToAssistant(msg, state.pendingReasoning);
      } else if (attach && state.lastAssistantIndex !== null) {
        attachPendingReasoningToAssistant(messages[state.lastAssistantIndex], state.pendingReasoning);
      }
      updateLastAssistantIndex(msg);
      messages.push(msg);
    } else if (state.pendingMedia.length === 0) {
      // 惰性 item 收尾 pending tool-call 批次
      flushToolCalls();
    }
  };

  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    for (const item of input) appendItem(item);
  } else if (input && typeof input === 'object') {
    appendItem(input);
  }

  flushPendingToolMedia(messages, state.pendingMedia);
  flushToolCalls();
  // input 处理完毕后剩余的 pending reasoning 属于真正的尾部, 回溯附挂到上一条 assistant
  if (attach && state.lastAssistantIndex !== null) {
    attachPendingReasoningToAssistant(messages[state.lastAssistantIndex], state.pendingReasoning);
  }
  if (attach) backfillToolCallReasoningPlaceholders(messages);
  return messages;
}

/**
 * Responses 请求 -> Chat Completions 请求
 * 对应 cc-switch transform_codex_chat.rs::responses_to_chat_completions_with_reasoning
 * (无 provider 配置时的通用路径)
 */
function responsesToChatCompletions(body, opts = {}) {
  const result = {};
  if (body.model !== undefined) result.model = body.model;

  const messages = [];
  const instructions = instructionText(body.instructions);
  if (instructions !== '') {
    messages.push({ role: 'system', content: instructions });
  }
  if (body.input !== undefined) {
    messages.push(...appendResponsesInput(body.input, opts));
  }
  result.messages = collapseSystemMessagesToHead(messages);

  const model = body.model || '';
  if (body.max_output_tokens !== undefined) {
    if (isOpenaiOSeries(model)) result.max_completion_tokens = body.max_output_tokens;
    else result.max_tokens = body.max_output_tokens;
  }
  if (body.max_tokens !== undefined) result.max_tokens = body.max_tokens;
  if (body.max_completion_tokens !== undefined) result.max_completion_tokens = body.max_completion_tokens;
  for (const key of ['temperature', 'top_p', 'stream']) {
    if (body[key] !== undefined) result[key] = body[key];
  }

  // Responses reasoning.effort -> chat reasoning_effort (仅支持 effort 的模型)
  if (supportsReasoningEffort(model) && body.reasoning
      && typeof body.reasoning === 'object' && typeof body.reasoning.effort === 'string') {
    result.reasoning_effort = body.reasoning.effort;
  }

  if (Array.isArray(body.tools) && body.tools.length > 0) {
    const ctx = new ToolContext();
    ctx.buildFromRequest(body);
    if (ctx.chatTools.length > 0) result.tools = ctx.chatTools;
    if (body.tool_choice !== undefined) {
      result.tool_choice = responsesToolChoiceToChat(body.tool_choice, ctx);
    }
  }

  for (const key of EXTRA_CHAT_PASSTHROUGH_FIELDS) {
    if (body[key] !== undefined) result[key] = body[key];
  }

  // 严格兼容上游 (vLLM/企业网关) 拒绝 tools 为空时带 tool_choice/parallel_tool_calls
  const hasTools = Array.isArray(result.tools) && result.tools.length > 0;
  if (!hasTools) {
    delete result.tool_choice;
    delete result.parallel_tool_calls;
  }

  injectStreamIncludeUsage(result);
  return result;
}

// ---------------------------------------------------------------------------
// Chat Completions 响应 -> Responses 响应 (非流式)
// ---------------------------------------------------------------------------

function chatUsageToResponsesUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) {
    return {
      input_tokens: 0,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens: 0,
      total_tokens: 0,
      output_tokens_details: { reasoning_tokens: 0 }
    };
  }
  const inputTokens = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const outputTokens = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const totalTokens = usage.total_tokens ?? (inputTokens + outputTokens);

  const result = {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    total_tokens: totalTokens
  };

  const directCacheRead = usage.cache_read_input_tokens;
  const cached = directCacheRead
    ?? usage.prompt_tokens_details?.cached_tokens
    ?? usage.input_tokens_details?.cached_tokens
    ?? usage.prompt_cache_hit_tokens
    ?? 0;
  const cacheWrite = usage.prompt_tokens_details?.cache_write_tokens
    ?? usage.input_tokens_details?.cache_write_tokens
    ?? usage.cache_creation_input_tokens
    ?? 0;

  if (cached > 0 || cacheWrite > 0) {
    result.input_tokens_details = { cached_tokens: cached, cache_write_tokens: cacheWrite };
  } else {
    result.input_tokens_details = { cached_tokens: 0 };
  }

  if (usage.completion_tokens_details && typeof usage.completion_tokens_details === 'object') {
    const details = { ...usage.completion_tokens_details };
    if (details.reasoning_tokens === undefined) details.reasoning_tokens = 0;
    result.output_tokens_details = details;
  } else {
    result.output_tokens_details = { reasoning_tokens: 0 };
  }

  if (directCacheRead !== undefined) result.cache_read_input_tokens = directCacheRead;
  if (cacheWrite > 0) result.cache_creation_input_tokens = cacheWrite;
  return result;
}

function responseIdFromChatId(id) {
  const raw = id || 'ccswitch';
  return raw.startsWith('resp_') ? raw : `resp_${raw}`;
}

function responseStatusFromFinishReason(finishReason) {
  return finishReason === 'length' ? 'incomplete' : 'completed';
}

// <think>...</think> 前缀拆分: 返回 [reasoning, answer] 或 null
function splitLeadingThinkBlock(text) {
  const leadingWsLen = text.length - text.trimStart().length;
  const afterWs = text.slice(leadingWsLen);
  if (!afterWs.startsWith('<think>')) return null;
  const bodyStart = leadingWsLen + '<think>'.length;
  const closeRel = text.slice(bodyStart).indexOf('</think>');
  if (closeRel === -1) return null;
  const closeStart = bodyStart + closeRel;
  const answerStart = closeStart + '</think>'.length;
  return [
    text.slice(bodyStart, closeStart).trim(),
    text.slice(answerStart).replace(/^[\r\n\t ]+/, '')
  ];
}

function stripLeadingThinkOpenTag(text) {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('<think>')) return null;
  return trimmed.slice('<think>'.length).trim();
}

function chatReasoningText(message) {
  const direct = extractReasoningFieldText(message);
  if (direct) return direct;
  if (typeof message.content === 'string') {
    const split = splitLeadingThinkBlock(message.content);
    if (split && split[0] !== '') return split[0];
  }
  return null;
}

// 响应方向: chat 工具名还原成 Responses 工具 item
function responseToolCallItemFromChatName(toolContext, itemId, status, callId, chatName, argumentsStr, reasoning) {
  const spec = toolContext.lookup(chatName);
  if (spec && spec.kind === 'toolSearch') {
    let parsed = {};
    try { parsed = JSON.parse(argumentsStr); } catch { /* keep {} */ }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) parsed = { query: argumentsStr };
    return { type: 'tool_search_call', call_id: callId, status, execution: 'client', arguments: parsed };
  }
  if (spec && spec.kind === 'custom') {
    let input = argumentsStr;
    try {
      const parsed = JSON.parse(argumentsStr);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
          && typeof parsed[CUSTOM_TOOL_INPUT_FIELD] === 'string') {
        input = parsed[CUSTOM_TOOL_INPUT_FIELD];
      }
    } catch { /* 非 JSON, 原样 */ }
    const item = {
      id: itemId, type: 'custom_tool_call', status, call_id: callId, name: spec.name, input
    };
    if (reasoning && reasoning.trim() !== '') item.reasoning_content = reasoning;
    return item;
  }
  const item = {
    id: itemId, type: 'function_call', status, call_id: callId, name: chatName, arguments: argumentsStr
  };
  if (spec && spec.kind === 'namespace') {
    item.name = spec.name;
    item.namespace = spec.namespace;
  }
  if (reasoning && reasoning.trim() !== '') item.reasoning_content = reasoning;
  return item;
}

function responseToolCallItemIdFromChatName(toolContext, callId, chatName) {
  return toolContext.isCustom(chatName) ? `ctc_${callId}` : `fc_${callId}`;
}

// chat 错误体 -> Responses 错误体 (Codex 只识别这个形状)
function chatErrorToResponseError(body) {
  if (!body) {
    return {
      error: {
        message: 'Upstream returned an empty error response',
        type: 'upstream_error',
        code: null,
        param: null
      }
    };
  }
  if (typeof body === 'string') {
    return { error: { message: body, type: 'upstream_error', code: null, param: null } };
  }
  const e = body.error || body;
  let message = e.message || e.detail;
  if (typeof message !== 'string') message = JSON.stringify(body);
  return {
    error: {
      message,
      type: e.type || e.code || 'upstream_error',
      code: e.code === undefined ? null : e.code,
      param: e.param === undefined ? null : e.param
    }
  };
}

/**
 * Chat Completions 响应 -> Responses 响应 (非流式)
 * 对应 cc-switch transform_codex_chat.rs::chat_completion_to_response_with_context
 */
function chatCompletionToResponse(body, toolContext) {
  const ctx = toolContext || new ToolContext();
  const choices = body && body.choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('No choices in chat response');
  }
  const choice = choices[0];
  const message = choice.message;
  if (!message) throw new Error('No message in chat choice');

  const responseId = responseIdFromChatId(typeof body.id === 'string' ? body.id : undefined);
  const model = body.model || '';
  const createdAt = body.created || 0;
  const finishReason = choice.finish_reason;

  const output = [];
  const reasoning = chatReasoningText(message);
  if (reasoning && reasoning !== '') {
    output.push({
      id: `rs_${responseId}`,
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: reasoning }]
    });
  }

  // message item (content: output_text / refusal)
  const content = [];
  if (typeof message.content === 'string') {
    const split = splitLeadingThinkBlock(message.content);
    const text = split ? split[1] : message.content;
    if (text !== '') content.push({ type: 'output_text', text, annotations: [] });
  } else if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if ((part.type === 'text' || part.type === 'output_text')
          && typeof part.text === 'string' && part.text !== '') {
        content.push({ type: 'output_text', text: part.text, annotations: [] });
      } else if (part.type === 'refusal' && typeof part.refusal === 'string' && part.refusal !== '') {
        content.push({ type: 'refusal', refusal: part.refusal });
      }
    }
  }
  if (typeof message.refusal === 'string' && message.refusal !== '') {
    content.push({ type: 'refusal', refusal: message.refusal });
  }
  if (content.length > 0) {
    output.push({
      id: `${responseId}_msg`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content
    });
  }

  // tool calls (缺名的调用丢弃; 全部丢弃且本应 completed 时报错, 见 cc-switch #4341)
  let dropped = 0;
  if (Array.isArray(message.tool_calls)) {
    message.tool_calls.forEach((tc, index) => {
      const fn = tc.function || {};
      const name = fn.name || '';
      if (name.trim() === '') {
        dropped++;
        return;
      }
      const callId = (tc.id && tc.id !== '') ? tc.id : `call_${index}`;
      const argumentsStr = canonicalizeToolArguments(fn.arguments);
      output.push(responseToolCallItemFromChatName(
        ctx,
        responseToolCallItemIdFromChatName(ctx, callId, name),
        'completed', callId, name, argumentsStr, reasoning
      ));
    });
  } else if (message.function_call) {
    const fc = message.function_call;
    const name = fc.name || '';
    if (name.trim() === '') dropped++;
    else {
      const callId = (fc.id && fc.id !== '') ? fc.id : 'call_0';
      const argumentsStr = canonicalizeToolArguments(fc.arguments);
      output.push(responseToolCallItemFromChatName(
        ctx,
        responseToolCallItemIdFromChatName(ctx, callId, name),
        'completed', callId, name, argumentsStr, reasoning
      ));
    }
  }

  const status = responseStatusFromFinishReason(finishReason);
  if (status === 'completed' && dropped > 0
      && !output.some((i) => ['function_call', 'custom_tool_call', 'tool_search_call'].includes(i.type))) {
    throw new Error(
      `Upstream returned ${dropped} tool call(s) without a function name, leaving no usable tool call in this turn`
    );
  }

  const response = {
    id: responseId,
    object: 'response',
    created_at: createdAt,
    status,
    model,
    output,
    usage: chatUsageToResponsesUsage(body.usage)
  };
  if (finishReason === 'length') {
    response.incomplete_details = { reason: 'max_output_tokens' };
  }
  return response;
}

// ---------------------------------------------------------------------------
// Chat SSE -> Responses SSE (流式)
// 对应 cc-switch streaming_codex_chat.rs + codex_responses_sse.rs
// ---------------------------------------------------------------------------

function sseEventFrame(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function responsesOutputItemAdded(outputIndex, item) {
  return sseEventFrame('response.output_item.added', {
    type: 'response.output_item.added', output_index: outputIndex, item
  });
}

function responsesOutputItemDone(outputIndex, item) {
  return sseEventFrame('response.output_item.done', {
    type: 'response.output_item.done', output_index: outputIndex, item
  });
}

function responsesMessageClose(outputIndex, itemId, text) {
  const item = {
    id: itemId, type: 'message', status: 'completed', role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [] }]
  };
  const events = [
    sseEventFrame('response.output_text.done', {
      type: 'response.output_text.done', item_id: itemId, output_index: outputIndex,
      content_index: 0, text
    }),
    sseEventFrame('response.content_part.done', {
      type: 'response.content_part.done', item_id: itemId, output_index: outputIndex,
      content_index: 0, part: { type: 'output_text', text, annotations: [] }
    }),
    responsesOutputItemDone(outputIndex, item)
  ];
  return { events, item };
}

function responsesReasoningClose(outputIndex, itemId, text) {
  const item = {
    id: itemId, type: 'reasoning',
    summary: [{ type: 'summary_text', text }]
  };
  const events = [
    sseEventFrame('response.reasoning_summary_text.done', {
      type: 'response.reasoning_summary_text.done', item_id: itemId, output_index: outputIndex,
      summary_index: 0, text
    }),
    sseEventFrame('response.reasoning_summary_part.done', {
      type: 'response.reasoning_summary_part.done', item_id: itemId, output_index: outputIndex,
      summary_index: 0, part: { type: 'summary_text', text }
    }),
    responsesOutputItemDone(outputIndex, item)
  ];
  return { events, item };
}

class ResponsesStreamConverter {
  constructor(toolContext = new ToolContext(), opts = {}) {
    this.toolContext = toolContext;
    this.attachReasoning = !!opts.attachReasoning;
    this.responseStarted = false;
    this.completed = false;
    this.failed = false;
    this.responseId = 'resp_ccswitch';
    this.model = '';
    this.createdAt = 0;
    this.nextOutputIndex = 0;
    this.text = { added: false, done: false, outputIndex: null, itemId: '', text: '' };
    this.reasoning = { added: false, done: false, outputIndex: null, itemId: '', text: '' };
    // inline <think> 处理 (MiniMax 等把思考内联进 content)
    this.inlineThink = { mode: 'detecting', buffer: '' };
    this.tools = new Map(); // chat index -> 状态
    this.nextToolIndexToAdd = 0;
    this.outputItems = [];
    this.latestUsage = null;
    this.finishReason = null;
    this.droppedToolCalls = 0;
  }

  baseResponse(status, output) {
    return {
      id: this.responseId,
      object: 'response',
      created_at: this.createdAt,
      status,
      model: this.model,
      output,
      usage: this.latestUsage || chatUsageToResponsesUsage(null)
    };
  }

  completedOutputItems() {
    return this.outputItems
      .slice()
      .sort((a, b) => a.outputIndex - b.outputIndex)
      .map((e) => e.item);
  }

  failedEvent(message, errorType) {
    this.completed = true;
    const error = { message };
    if (errorType) error.type = errorType;
    const response = this.baseResponse('failed', this.completedOutputItems());
    response.error = error;
    return sseEventFrame('response.failed', { type: 'response.failed', response });
  }

  ensureResponseStarted() {
    if (this.responseStarted) return [];
    this.responseStarted = true;
    const response = this.baseResponse('in_progress', []);
    return [
      sseEventFrame('response.created', { type: 'response.created', response }),
      sseEventFrame('response.in_progress', { type: 'response.in_progress', response })
    ];
  }

  pushReasoningDelta(delta) {
    const out = [];
    if (!this.reasoning.added) {
      const outputIndex = this.nextOutputIndex++;
      const itemId = `rs_${this.responseId}`;
      this.reasoning.outputIndex = outputIndex;
      this.reasoning.itemId = itemId;
      this.reasoning.added = true;
      out.push(responsesOutputItemAdded(outputIndex, {
        id: itemId, type: 'reasoning', status: 'in_progress', summary: []
      }));
      out.push(sseEventFrame('response.reasoning_summary_part.added', {
        type: 'response.reasoning_summary_part.added', item_id: itemId,
        output_index: outputIndex, summary_index: 0,
        part: { type: 'summary_text', text: '' }
      }));
    }
    this.reasoning.text += delta;
    out.push(sseEventFrame('response.reasoning_summary_text.delta', {
      type: 'response.reasoning_summary_text.delta', item_id: this.reasoning.itemId,
      output_index: this.reasoning.outputIndex, summary_index: 0, delta
    }));
    return out;
  }

  pushTextDelta(delta) {
    const out = [];
    if (!this.text.added) {
      const outputIndex = this.nextOutputIndex++;
      const itemId = `${this.responseId}_msg`;
      this.text.outputIndex = outputIndex;
      this.text.itemId = itemId;
      this.text.added = true;
      out.push(responsesOutputItemAdded(outputIndex, {
        id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: []
      }));
      out.push(sseEventFrame('response.content_part.added', {
        type: 'response.content_part.added', item_id: itemId, output_index: outputIndex,
        content_index: 0, part: { type: 'output_text', text: '', annotations: [] }
      }));
    }
    this.text.text += delta;
    out.push(sseEventFrame('response.output_text.delta', {
      type: 'response.output_text.delta', item_id: this.text.itemId,
      output_index: this.text.outputIndex, content_index: 0, delta
    }));
    return out;
  }

  // ---------- inline <think> ----------
  leadingThinkPrefixDecision(buffer) {
    const trimmed = buffer.trimStart();
    if (trimmed === '') return 'needMore';
    if (trimmed.startsWith('<think>')) return 'reasoning';
    if ('<think>'.startsWith(trimmed)) return 'needMore';
    return 'text';
  }

  drainCompleteInlineThink() {
    const split = splitLeadingThinkBlock(this.inlineThink.buffer);
    if (!split) return [];
    this.inlineThink.mode = 'text';
    this.inlineThink.buffer = '';
    const out = [];
    if (split[0] !== '') {
      out.push(...this.pushReasoningDelta(split[0]));
      out.push(...this.finalizeReasoning());
    }
    if (split[1] !== '') out.push(...this.pushTextDelta(split[1]));
    return out;
  }

  flushInlineThinkAtBoundary() {
    if (this.inlineThink.mode === 'text') return [];
    if (this.inlineThink.mode === 'detecting') {
      this.inlineThink.mode = 'text';
      const text = this.inlineThink.buffer;
      this.inlineThink.buffer = '';
      if (text === '') return [];
      return [...this.finalizeReasoning(), ...this.pushTextDelta(text)];
    }
    // reasoning 模式: 拆完整的 think 块; 拆不出则剥掉开标签按 reasoning 处理
    const buffered = this.inlineThink.buffer;
    this.inlineThink.mode = 'text';
    this.inlineThink.buffer = '';
    const split = splitLeadingThinkBlock(buffered);
    if (split) {
      const out = [];
      if (split[0] !== '') {
        out.push(...this.pushReasoningDelta(split[0]));
        out.push(...this.finalizeReasoning());
      }
      if (split[1] !== '') out.push(...this.pushTextDelta(split[1]));
      return out;
    }
    const reasoning = stripLeadingThinkOpenTag(buffered) || buffered;
    if (reasoning === '') return [];
    return [...this.pushReasoningDelta(reasoning), ...this.finalizeReasoning()];
  }

  pushContentDelta(delta) {
    if (this.inlineThink.mode === 'text') {
      return [...this.finalizeReasoning(), ...this.pushTextDelta(delta)];
    }
    if (this.inlineThink.mode === 'detecting') {
      this.inlineThink.buffer += delta;
      const decision = this.leadingThinkPrefixDecision(this.inlineThink.buffer);
      if (decision === 'needMore') return [];
      if (decision === 'reasoning') {
        this.inlineThink.mode = 'reasoning';
        return this.drainCompleteInlineThink();
      }
      this.inlineThink.mode = 'text';
      const text = this.inlineThink.buffer;
      this.inlineThink.buffer = '';
      return [...this.finalizeReasoning(), ...this.pushTextDelta(text)];
    }
    this.inlineThink.buffer += delta;
    return this.drainCompleteInlineThink();
  }

  currentReasoningText() {
    return this.reasoning.text.trim() === '' ? null : this.reasoning.text.trim();
  }

  // ---------- 工具调用 ----------
  resolveToolKeyWithoutIndex(toolCall) {
    let lastKey = null;
    for (const k of this.tools.keys()) lastKey = k;
    const id = toolCall.id;
    if (typeof id !== 'string' || id === '') return lastKey === null ? 0 : lastKey;
    for (const [key, state] of this.tools) {
      if (state.callId === id) return key;
    }
    return lastKey === null ? 0 : lastKey + 1;
  }

  pushToolCallDelta(toolCall, reasoning) {
    const chatIndex = typeof toolCall.index === 'number'
      ? toolCall.index
      : this.resolveToolKeyWithoutIndex(toolCall);
    const fn = toolCall.function || {};

    let state = this.tools.get(chatIndex);
    if (!state) {
      state = {
        outputIndex: null, itemId: '', callId: '', name: '',
        arguments: '', reasoningContent: '', added: false, done: false
      };
      this.tools.set(chatIndex, state);
    }
    if (toolCall.id) state.callId = toolCall.id;
    if (fn.name) state.name = fn.name;
    if (typeof fn.arguments === 'string' && fn.arguments !== '') {
      state.arguments += fn.arguments;
    }
    if (state.reasoningContent === '' && reasoning && reasoning.trim() !== '') {
      state.reasoningContent = reasoning.trim();
    }

    let outputIndex = null;
    let itemId = '';
    if (state.added) {
      outputIndex = state.outputIndex;
      itemId = state.itemId;
    }

    const isCustom = this.toolContext.isCustom(state.name);
    const out = [];
    if (typeof fn.arguments === 'string' && fn.arguments !== '' && !isCustom
        && outputIndex !== null) {
      out.push(sseEventFrame('response.function_call_arguments.delta', {
        type: 'response.function_call_arguments.delta', item_id: itemId,
        output_index: outputIndex, delta: fn.arguments
      }));
    }
    out.push(...this.flushReadyToolCalls());
    return out;
  }

  flushReadyToolCalls() {
    const out = [];
    for (;;) {
      const key = this.nextToolIndexToAdd;
      const state = this.tools.get(key);
      if (!state) break;
      if (state.added || state.done) {
        this.nextToolIndexToAdd++;
        continue;
      }
      if (state.callId === '' || state.name === '') break;

      const assigned = this.nextOutputIndex++;
      state.added = true;
      state.outputIndex = assigned;
      state.itemId = responseToolCallItemIdFromChatName(this.toolContext, state.callId, state.name);
      const item = responseToolCallItemFromChatName(
        this.toolContext, state.itemId, 'in_progress', state.callId, state.name,
        '', this.attachReasoning ? state.reasoningContent : null
      );
      out.push(responsesOutputItemAdded(assigned, item));
      if (state.arguments !== '' && !this.toolContext.isCustom(state.name)) {
        out.push(sseEventFrame('response.function_call_arguments.delta', {
          type: 'response.function_call_arguments.delta', item_id: state.itemId,
          output_index: assigned, delta: state.arguments
        }));
      }
      this.nextToolIndexToAdd++;
    }
    return out;
  }

  appendReasoningToActiveTools(delta) {
    if (delta.trim() === '') return;
    for (const state of this.tools.values()) {
      if (state.done) continue;
      state.reasoningContent = state.reasoningContent === ''
        ? delta.trimStart()
        : state.reasoningContent + delta;
    }
  }

  hasSubstantiveOutput() {
    if (this.text.text.trim() !== '' || this.reasoning.text.trim() !== '') return true;
    if (this.inlineThink.buffer.trim() !== '') return true;
    if (this.outputItems.length > 0) return true;
    for (const state of this.tools.values()) {
      if (state.added || state.callId.trim() !== '' || state.name.trim() !== ''
          || state.arguments.trim() !== '' || state.reasoningContent.trim() !== '') {
        return true;
      }
    }
    return false;
  }

  hasEmittedToolCall() {
    return this.outputItems.some((e) =>
      ['function_call', 'custom_tool_call', 'tool_search_call'].includes(e.item.type));
  }

  finalizeReasoning() {
    if (!this.reasoning.added || this.reasoning.done) return [];
    const outputIndex = this.reasoning.outputIndex;
    const itemId = this.reasoning.itemId;
    const text = this.reasoning.text;
    const { events, item } = responsesReasoningClose(outputIndex, itemId, text);
    this.outputItems.push({ outputIndex, item });
    this.reasoning.done = true;
    return events;
  }

  finalizeText() {
    if (!this.text.added || this.text.done) return [];
    const outputIndex = this.text.outputIndex;
    const itemId = this.text.itemId;
    const text = this.text.text;
    const { events, item } = responsesMessageClose(outputIndex, itemId, text);
    this.outputItems.push({ outputIndex, item });
    this.text.done = true;
    return events;
  }

  finalizeTools() {
    const out = [];
    const keys = [...this.tools.keys()].sort((a, b) => a - b);
    for (const key of keys) {
      const state = this.tools.get(key);
      if (state.done) continue;

      // 缺合法函数名的调用丢弃 (防御: 部分模型生成畸形工具调用)
      if (state.name.trim() === '') {
        state.done = true;
        this.droppedToolCalls++;
        continue;
      }

      if (!state.added) {
        const assigned = this.nextOutputIndex++;
        state.added = true;
        if (state.callId === '') state.callId = `call_${key}`;
        state.outputIndex = assigned;
        state.itemId = responseToolCallItemIdFromChatName(this.toolContext, state.callId, state.name);
        const item = responseToolCallItemFromChatName(
          this.toolContext, state.itemId, 'in_progress', state.callId, state.name,
          '', this.attachReasoning ? state.reasoningContent : null
        );
        out.push(responsesOutputItemAdded(assigned, item));
      }

      const argumentsStr = canonicalizeToolArgumentsStr(state.arguments);
      const isCustom = this.toolContext.isCustom(state.name);
      const item = responseToolCallItemFromChatName(
        this.toolContext, state.itemId, 'completed', state.callId, state.name,
        argumentsStr, this.attachReasoning ? state.reasoningContent : null
      );
      state.done = true;
      this.outputItems.push({ outputIndex: state.outputIndex, item });

      if (isCustom) {
        let input = '';
        try {
          const parsed = JSON.parse(argumentsStr);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
              && typeof parsed[CUSTOM_TOOL_INPUT_FIELD] === 'string') {
            input = parsed[CUSTOM_TOOL_INPUT_FIELD];
          } else {
            input = argumentsStr;
          }
        } catch { input = argumentsStr; }
        if (input !== '') {
          out.push(sseEventFrame('response.custom_tool_call_input.delta', {
            type: 'response.custom_tool_call_input.delta', item_id: state.itemId,
            output_index: state.outputIndex, delta: input
          }));
        }
        out.push(sseEventFrame('response.custom_tool_call_input.done', {
          type: 'response.custom_tool_call_input.done', item_id: state.itemId,
          output_index: state.outputIndex, input
        }));
      } else {
        out.push(sseEventFrame('response.function_call_arguments.done', {
          type: 'response.function_call_arguments.done', item_id: state.itemId,
          output_index: state.outputIndex, arguments: argumentsStr
        }));
      }
      out.push(responsesOutputItemDone(state.outputIndex, item));
    }
    return out;
  }

  finalize() {
    if (this.completed) return [];
    let out = [...this.ensureResponseStarted()];
    out.push(...this.flushInlineThinkAtBoundary());
    out.push(...this.finalizeReasoning());
    out.push(...this.finalizeText());
    out.push(...this.finalizeTools());

    const status = responseStatusFromFinishReason(this.finishReason);

    // 丢弃过工具调用、且最终一个工具调用都没剩下 -> 如实报错 (cc-switch #4341)
    if (status === 'completed' && this.droppedToolCalls > 0 && !this.hasEmittedToolCall()) {
      out.push(this.failedEvent(
        `Upstream returned ${this.droppedToolCalls} tool call(s) without a function name, ` +
        'leaving no usable tool call in this turn',
        'upstream_tool_call_dropped'
      ));
      return out;
    }

    const response = this.baseResponse(status, this.completedOutputItems());
    if (status === 'incomplete') {
      response.incomplete_details = { reason: 'max_output_tokens' };
    }
    out.push(sseEventFrame('response.completed', { type: 'response.completed', response }));
    this.completed = true;
    return out;
  }

  // 输入一条上游 SSE "data:" 载荷, 返回出站帧
  push(data) {
    if (data.trim() === '[DONE]') return this.finalize();
    let chunk;
    try { chunk = JSON.parse(data); } catch { return []; }

    if (chunk.error !== undefined) {
      const error = chunk.error;
      let message;
      let errorType;
      if (typeof error === 'string') {
        message = error;
      } else if (error && typeof error === 'object') {
        message = error.message || error.detail || JSON.stringify(error);
        errorType = error.type || error.code;
      } else {
        message = JSON.stringify(chunk);
      }
      this.failed = true;
      return [this.failedEvent(message, errorType)];
    }

    if (typeof chunk.id === 'string') this.responseId = responseIdFromChatId(chunk.id);
    if (typeof chunk.model === 'string' && chunk.model !== '') this.model = chunk.model;
    if (typeof chunk.created === 'number') this.createdAt = chunk.created;

    let out = [...this.ensureResponseStarted()];
    if (chunk.usage) this.latestUsage = chatUsageToResponsesUsage(chunk.usage);

    const choice = (chunk.choices || [])[0];
    if (!choice) return out;

    const delta = choice.delta || {};
    const reasoning = extractReasoningFieldText(delta);
    if (reasoning) {
      out.push(...this.pushReasoningDelta(reasoning));
      this.appendReasoningToActiveTools(reasoning);
    }
    if (typeof delta.content === 'string' && delta.content !== '') {
      out.push(...this.pushContentDelta(delta.content));
    }
    if (Array.isArray(delta.tool_calls)) {
      out.push(...this.flushInlineThinkAtBoundary());
      const reasoningForCall = this.currentReasoningText();
      out.push(...this.finalizeReasoning());
      for (const tc of delta.tool_calls) {
        out.push(...this.pushToolCallDelta(tc, reasoningForCall));
      }
    }
    if (typeof choice.finish_reason === 'string') {
      this.finishReason = choice.finish_reason;
    }
    return out;
  }

  // 流结束但没收到 [DONE]
  flush() {
    if (this.failed) return [];
    if (this.completed || this.finishReason !== null) return this.finalize();
    if (this.hasSubstantiveOutput()) {
      this.finishReason = 'length';
      return this.finalize();
    }
    return [this.failedEvent(
      'Upstream Chat Completions stream ended before sending finish_reason',
      'stream_truncated'
    )];
  }
}

module.exports = {
  // 请求转换
  anthropicToOpenAI,
  responsesToChatCompletions,
  ToolContext,
  // 非流式响应转换
  openaiToAnthropic,
  chatCompletionToResponse,
  // 流式响应转换
  AnthropicStreamConverter,
  ResponsesStreamConverter,
  // 错误转换
  chatErrorToAnthropicError,
  chatErrorToResponseError,
  // 工具函数 (测试用)
  canonicalJsonString,
  canonicalizeToolArguments,
  isOpenaiOSeries,
  supportsReasoningEffort,
  stripLeadingAnthropicBillingHeader
};
