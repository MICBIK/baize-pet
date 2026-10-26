# ADR 0003：Token 用量统计与估算策略

- 状态：已接受 · 2026-10-26

## 背景

docs/07 M4 要求"用户可设置单日 token 上限，超出后停止调用并提示"。流式响应中并非所有供应商都返回 usage：OpenAI 兼容端点需要 `stream_options.include_usage`（部分第三方兼容实现会忽略），Anthropic 的用量分散在 `message_start` / `message_delta` 事件中。

## 决定

- 优先采用供应商报告的真实用量（`ChatDelta.totalTokens`，取流中最后一次报告）。
- 供应商未报告时，按字符数保守估算：`tokens = ceil(chars / 2)`。中文对话按"1 token ≈ 2 字符"估算偏高（真实约 1.4–2 字符/token），宁可高估也不让用户意外超额。
- 估算还覆盖未计入 real usage 的部分：system prompt 与历史轮次按同法估算后一并累加。
- 用量按本地日期（YYYY-MM-DD）累计存于 `config.json` 的 `tokenUsage`；跨日自动清零。上限 `dailyTokenLimit = null` 表示不限。
- 达到上限后不再发起调用，聊天窗口显示友好提示，次日自动恢复。

## 备选方案

| 方案 | 不选的原因 |
|---|---|
| 仅统计供应商报告的 usage | 部分兼容端点不返回，预算会被低估 |
| 引入 tiktoken 等 tokenizer | 依赖重（dictionary 数十 MB），且对非 OpenAI 模型的 tokenizer 不匹配 |
| 按请求次数限流 | 与"token 上限"的需求语义不符 |

## 后果

- 估算值偏保守，用户可能提前触顶；设置页明示上限数值，用户可自行调高。
- 换供应商不需要改预算逻辑（估算与真实 usage 都在适配器层之上统计）。
