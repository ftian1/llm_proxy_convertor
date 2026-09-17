# #156 最小复现: 末条 `role:"system"` 触发上游空响应

Claude Code CLI 会把后台任务通知(`<task-notification>`)以 `role:"system"` 追加在
`messages` 末尾。某些上游(实测 `deepseek-v4-flash-0731` / Azure)遇到这种「末条 system +
文案自称没有用户输入」的请求, 会返回 `finish_reason=stop`、`output_tokens:1`、没有任何
可见正文 —— Claude Code TUI 里就表现为 **"Done 但没有任何输出"**。

## 文件

| 文件 | 说明 |
| --- | --- |
| `system.json` | 待测样本: 末条 `role:"system"`, 内容就是 #156 原文(逐字, 1532 字符) |
| `user.json` | 对照组: 与 `system.json` **只差 role 一个字段**, 其余逐字相同 |
| `run.sh` | 依次打两条请求并判定 |

## 用法

```bash
# 网关需开着 (默认 http://127.0.0.1:18080)
./run.sh                       # 或 ./run.sh http://127.0.0.1:18080
```

退出码: `0` = 已被归一(默认行为) · `2` = 复现空响应 · `1` = 连不上或对照组异常。

想看到复现, 网关要用 `NORMALIZE_INLINE_SYSTEM=0` 起:

```bash
NORMALIZE_INLINE_SYSTEM=0 LOG_FILE=/tmp/repro.jsonl \
  UPSTREAM_URL=... UPSTREAM_TOKEN=... node server.js
./run.sh
```

## 实测记录(`deepseek-v4-flash-0731`, 真实上游)

| 末条 role | events | 可见正文 | output_tokens | stop_reason |
| --- | --- | --- | --- | --- |
| `system` | 3 | 0 字符 | 1 | `end_turn` |
| `user` | 54 | 300 字符 | 507 | `end_turn` |

两条都 2/2 稳定复现, 且上游对相同输入是确定性的(响应 id 相同), 所以「空响应就重试」没用。

`user` 变体实际生成的正文(即 Claude Code 本应显示的内容):

> The `vllm-openai-xpu` image has been pulled successfully and is now present on the system.
> The monitor has ended, and the image tag `vllm-openai-xpu:latest` is available for use.
>
> If you need any further verification (e.g., image ID, size) or have a next step (like
> running a container), let me know.

## 相关

- `NORMALIZE_INLINE_SYSTEM`(默认开)只把**末条** `messages[].role === "system"` 按 `user`
  发送, 内容逐字不动; 中间位置的 system(环境 / `CLAUDE.md` / skills 上下文)保持不变。
- 空响应时网关日志会打印 `[#n] [WARN] 上游空响应:` 加出站消息末段, 直接指出是哪条 prompt。
- 原始完整请求(131 条消息 / ~700KB)不在仓库里; 本目录是它的最小化版本。
