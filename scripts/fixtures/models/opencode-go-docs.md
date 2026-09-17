## Usage limits

Usage limits are defined as monthly dollar amounts. The table below shows the
monthly limit and token costs for each model.

Each model has the following usage limits: 5-hour — 20% of the monthly limit;
weekly — 50%; and monthly — 100%.

For example, if a model has a $60 monthly limit, you can spend up to:

- **5-hour limit** — $12 of usage
- **Weekly limit** — $30 of usage
- **Monthly limit** — $60 of usage

Token prices are per 1M tokens.

| Model                                   | Input  | Output | Cached Read | Cached Write | Monthly limit                                        |
| --------------------------------------- | ------ | ------ | ----------- | ------------ | ---------------------------------------------------- |
| GLM-5.3-Flash                           | $0.15  | $0.50  | $0.03       | -            | **$60**                                              |
| GLM-5.3                                 | $1.40  | $4.40  | $0.26       | -            | **$15**                                              |
| GLM-5.2                                 | $1.40  | $4.40  | $0.26       | -            | **$60**                                              |
| GLM-5.1                                 | $1.40  | $4.40  | $0.26       | -            | **$60**                                              |
| Kimi K3                                 | $3.00  | $15.00 | $0.30       | -            | **$15**                                              |
| Kimi K2.7 Code                          | $0.95  | $4.00  | $0.19       | -            | **$60**                                              |
| Kimi K2.6                               | $0.95  | $4.00  | $0.16       | -            | **$60**                                              |
| LongCat-2.0                             | $0.30  | $1.20  | $0.006      | -            | **$60**                                              |
| MiMo V2.5                               | $0.14  | $0.28  | $0.0028     | -            | **$60**                                              |
| MiMo V2.5 Pro                           | $0.435 | $0.87  | $0.003625   | -            | **$15**                                              |
| MiniMax M3                              | $0.30  | $1.20  | $0.06       | -            | **$60**                                              |
| MiniMax M2.7                            | $0.30  | $1.20  | $0.06       | $0.375       | **$60**                                              |
| MiniMax M2.5                            | $0.30  | $1.20  | $0.06       | $0.375       | **$60**                                              |
| Muse Spark 1.3 Contributor              | $0.10  | $0.20  | $0.002      | -            | **$60**                                              |
| Muse Spark 1.2 Contributor              | $0.10  | $0.20  | $0.002      | -            | **$60**                                              |
| Qwen3.8 Max                             | $2.00  | $6.00  | $0.25       | $2.50        | **$15**                                              |
| Qwen3.8 Flash                           | $0.15  | $0.47  | $0.016      | $0.20        | **$30**                                              |
| Qwen3.7 Max                             | $2.50  | $7.50  | $0.50       | $3.125       | **$30**                                              |
| Qwen3.7 Plus (≤ 256K tokens)            | $0.40  | $1.60  | $0.04       | $0.50        | **$60**                                              |
| Qwen3.7 Plus (> 256K tokens)            | $1.20  | $4.80  | $0.12       | $1.50        | **$60**                                              |
| Qwen3.6 Plus (≤ 256K tokens)            | $0.50  | $3.00  | $0.05       | $0.625       | **$60**                                              |
| Qwen3.6 Plus (> 256K tokens)            | $2.00  | $6.00  | $0.20       | $2.50        | **$60**                                              |
| DeepSeek V4.1 Flash (Off-Peak)          | $0.15  | $0.60  | $0.003      | -            | ~~$15~~ **$60**<br /><small>4x · Ends Sep 20</small> |
| DeepSeek V4.1 Flash (Peak)              | $0.30  | $1.20  | $0.006      | -            | ~~$15~~ **$60**<br /><small>4x · Ends Sep 20</small> |
| DeepSeek V4 Pro (Off-Peak)              | $0.66  | $1.98  | $0.022      | -            | **$15**                                              |
| DeepSeek V4 Pro (Peak)                  | $1.32  | $3.96  | $0.044      | -            | **$15**                                              |
| DeepSeek V4 Flash (Off-Peak)            | $0.15  | $0.60  | $0.003      | -            | **$30**                                              |
| DeepSeek V4 Flash (Peak)                | $0.30  | $1.20  | $0.006      | -            | **$30**                                              |
| DeepSeek V4 Flash Vision Exp (Off-Peak) | $0.15  | $0.60  | $0.003      | -            | **$15**                                              |
| DeepSeek V4 Flash Vision Exp (Peak)     | $0.30  | $1.20  | $0.006      | -            | **$15**                                              |
| Hy4 preview                             | $0.834 | $2.501 | $0.042      | -            | **$30**                                              |
| Hy3                                     | $0.14  | $0.58  | $0.035      | -            | **$60**                                              |
| Union Alpha Free                        | Free   | Free   | Free        | -            | **Unlimited**<br /><small>limited time</small>       |
| Grok 4.6 (≤ 200K tokens)                | $2.00  | $6.00  | $0.50       | -            | **$15**                                              |
| Grok 4.6 (> 200K tokens)                | $4.00  | $12.00 | $1.00       | -            | **$15**                                              |
| GPT 5.6 Luna (≤ 272K tokens)            | $0.20  | $1.20  | $0.02       | $0.25        | **$15**                                              |
| GPT 5.6 Luna (> 272K tokens)            | $0.40  | $1.80  | $0.04       | $0.50        | **$15**                                              |

**DeepSeek V4.1 Flash / V4 Pro / V4 Flash / V4 Flash Vision Exp:** Peak hours are 01:00-04:00 and 06:00-10:00 UTC, Monday through Friday; all other hours, including weekends, are Off-Peak. [Learn more](https://api-docs.deepseek.com/quick_start/pricing/).

**DeepSeek V4 Flash Vision Exp:** Images are converted into tokens based on their dimensions and billed as input tokens alongside text tokens. [Learn more](https://api-docs.deepseek.com/quick_start/pricing/).

## Endpoints

You can also access Go models through the following API endpoints.

| Model                        | Model ID                     | Endpoint                                         | AI SDK Package              |
| ---------------------------- | ---------------------------- | ------------------------------------------------ | --------------------------- |
| Grok 4.6                     | grok-4.6                     | `https://opencode.ai/zen/go/v1/responses`        | `@ai-sdk/openai`            |
| GPT 5.6 Luna                 | gpt-5.6-luna                 | `https://opencode.ai/zen/go/v1/responses`        | `@ai-sdk/openai`            |
| GLM-5.3-Flash                | glm-5.3-flash                | `https://opencode.ai/zen/go/v1/chat/completions` | `@ai-sdk/openai-compatible` |
| GLM-5.3                      | glm-5.3                      | `https://opencode.ai/zen/go/v1/chat/completions` | `@ai-sdk/openai-compatible` |
| GLM-5.2                      | glm-5.2                      | `https://opencode.ai/zen/go/v1/chat/completions` | `@ai-sdk/openai-compatible` |
| GLM-5.1                      | glm-5.1                      | `https://opencode.ai/zen/go/v1/chat/completions` | `@ai-sdk/openai-compatible` |
| Kimi K3                      | kimi-k3                      | `https://opencode.ai/zen/go/v1/chat/completions` | `@ai-sdk/openai-compatible` |
| Kimi K2.7 Code               | kimi-k2.7-code               | `https://opencode.ai/zen/go/v1/chat/completions` | `@ai-sdk/openai-compatible` |
| Kimi K2.6                    | kimi-k2.6                    | `https://opencode.ai/zen/go/v1/chat/completions` | `@ai-sdk/openai-compatible` |
| LongCat-2.0                  | longcat-2.0                  | `https://opencode.ai/zen/go/v1/chat/completions` | `@ai-sdk/openai-compatible` |
| DeepSeek V4.1 Flash          | deepseek-v4.1-flash          | `https://opencode.ai/zen/go/v1/chat/completions` | `@ai-sdk/openai-compatible` |
| DeepSeek V4 Pro              | deepseek-v4-pro              | `https://opencode.ai/zen/go/v1/chat/completions` | `@ai-sdk/openai-compatible` |
| DeepSeek V4 Flash            | deepseek-v4-flash            | `https://opencode.ai/zen/go/v1/chat/completions` | `@ai-sdk/openai-compatible` |
| DeepSeek V4 Flash Vision Exp | deepseek-v4-flash-vision-exp | `https://opencode.ai/zen/go/v1/chat/completions` | `@ai-sdk/openai-compatible` |
| MiMo-V2.5                    | mimo-v2.5                    | `https://opencode.ai/zen/go/v1/chat/completions` | `@ai-sdk/openai-compatible` |
| MiMo-V2.5-Pro                | mimo-v2.5-pro                | `https://opencode.ai/zen/go/v1/chat/completions` | `@ai-sdk/openai-compatible` |
| MiniMax M3                   | minimax-m3                   | `https://opencode.ai/zen/go/v1/messages`         | `@ai-sdk/anthropic`         |
| MiniMax M2.7                 | minimax-m2.7                 | `https://opencode.ai/zen/go/v1/messages`         | `@ai-sdk/anthropic`         |
| MiniMax M2.5                 | minimax-m2.5                 | `https://opencode.ai/zen/go/v1/messages`         | `@ai-sdk/anthropic`         |
| Muse Spark 1.3 Contributor   | muse-spark-1.3-contributor   | `https://opencode.ai/zen/go/v1/responses`        | `@ai-sdk/openai`            |
| Muse Spark 1.2 Contributor   | muse-spark-1.2-contributor   | `https://opencode.ai/zen/go/v1/responses`        | `@ai-sdk/openai`            |
| Qwen3.8 Max                  | qwen3.8-max                  | `https://opencode.ai/zen/go/v1/messages`         | `@ai-sdk/anthropic`         |
| Qwen3.8 Flash                | qwen3.8-flash                | `https://opencode.ai/zen/go/v1/messages`         | `@ai-sdk/anthropic`         |
| Qwen3.7 Max                  | qwen3.7-max                  | `https://opencode.ai/zen/go/v1/messages`         | `@ai-sdk/anthropic`         |
| Qwen3.7 Plus                 | qwen3.7-plus                 | `https://opencode.ai/zen/go/v1/messages`         | `@ai-sdk/anthropic`         |
| Qwen3.6 Plus                 | qwen3.6-plus                 | `https://opencode.ai/zen/go/v1/messages`         | `@ai-sdk/anthropic`         |
| Hy4 preview                  | hy4-preview                  | `https://opencode.ai/zen/go/v1/chat/completions` | `@ai-sdk/openai-compatible` |
| Hy3                          | hy3                          | `https://opencode.ai/zen/go/v1/chat/completions` | `@ai-sdk/openai-compatible` |
| Union Alpha Free             | union-alpha                  | `https://opencode.ai/zen/go/v1/messages`         | `@ai-sdk/anthropic`         |

The [model id](/docs/config/#models) in your OpenCode config
uses the format `opencode-go/<model-id>`. For example, for Kimi K3, you would
use `opencode-go/kimi-k3` in your config.

---

