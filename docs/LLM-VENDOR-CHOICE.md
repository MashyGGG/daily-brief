# LLM 供应商选型 —— 检索、对比与推荐

> 检索日期：**2026-08-26**。所有价格取自当日官方定价页或官方文档，来源清单见 §8。
> 本文回答一个问题：`brief.config.yaml` 的 `LLM_API_KEY` 配下去之前，
> `provider.baseUrl` / `provider.model` 那两行应该写什么。
> 配套阅读：[`LLM-SUMMARY.md`](./LLM-SUMMARY.md)（链路怎么搭的）、
> [`brief.config.yaml`](../brief.config.yaml) §llm（唯一真相）。

---

## 0. 结论先行

|                           | 选择                                                      | 理由一句话                                                                               |
| ------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **立刻要改**              | `deepseek-chat` → `deepseek-v4-flash`                     | 这个模型名 **2026-07-24 15:59 UTC 已退役**，现在配 key 上去，每天早上 07:10 收到的是 404 |
| **主力**                  | `deepseek-v4-flash`（`https://api.deepseek.com/v1`）      | 中文母语级、OpenAI 兼容零改代码、**≈ ¥3.5/月**、4 个 cron 里 3 个落在半价时段            |
| **零成本兜底 / A-B 对照** | `GLM-4.7-Flash`（`https://open.bigmodel.cn/api/paas/v4`） | 永久免费、200K 上下文，靠 `LLM_BASE_URL` + `LLM_MODEL` 两个变量就能切，不动一行代码      |
| **质量升级档（可选）**    | `qwen3.7-plus`（¥2/¥8）                                   | 每月 ¥5，如果只是某一档不满意，先升它，别升全局                                          |
| **明确不选**              | GPT-5 系列 / Claude 系列                                  | 不是贵，是**要改 [`llm.ts`](../src/enrich/llm.ts)**，见 §5                               |

**成本不是这次选型的决定变量。** 全场景实测跨度是 **¥0 – ¥98/月**（§4），
连最贵的 Claude Opus 5 都不到一顿午饭。真正淘汰候选人的是 §5 的**接口契约**和 §6 的**任务匹配度**。

---

## 1. 这个项目让 LLM 做什么（实测，不是估算）

三个调用点，全部在 [`src/enrich/`](../src/enrich/)：

| 调用点           | 代码                                          | 输入                             | 输出                               | 风格约束                                  |
| ---------------- | --------------------------------------------- | -------------------------------- | ---------------------------------- | ----------------------------------------- |
| 条目摘要（技术） | [`index.ts:163`](../src/enrich/index.ts#L163) | 抓回的正文，截断到 6000 字符     | `{"summary": …, "takeaways": […]}` | ≤180 / 220 字符 + 2-3 条要点，每条 ≤30 字 |
| 条目摘要（要闻） | 同上                                          | 源自带 excerpt（实测 ≈100 字符） | 同上，`takeaways` 空数组           | `oneline`，≤120 字符                      |
| 全刊导读         | [`digest.ts:86`](../src/enrich/digest.ts#L86) | 24 条标题 + 每条 120 字符        | `{"digest": …}`                    | 3 句，≤240 字符                           |

任务的真实难度排序，**和「通用能力排行榜」几乎无关**：

1. **英文 → 中文的跨语言压缩**。`hn-front` / `lobsters` / `verge` 全是英文正文，
   [`prompt.ts:29`](../src/enrich/prompt.ts#L29) 要求「用 zh-CN 输出，无论原文是什么语言」。
   这是中文母语模型的主场，也是英文模型最容易翻出「翻译腔」的地方。
2. **字数硬约束**。180 / 220 / 120 / 240 四档。
   [`sanitize.ts:119`](../src/enrich/sanitize.ts#L119) 会硬截断，所以模型不听话**不会报错**——
   会安静地把最后半句话切掉。这是「指令遵从」直接变成读者可见质量的地方。
3. **JSON 稳定性**。[`sanitize.ts:116`](../src/enrich/sanitize.ts#L116) 有降级：解析失败就把整段当纯文本用。
   所以 JSON 崩了不会挂，但 `takeaways` 会整批消失。
4. **抗提示注入**。输入是**公开 RSS 抓回来的不可信正文**，产物直接提交进公开仓库并群发邮件，
   中间没有人审。[`prompt.ts:20`](../src/enrich/prompt.ts#L20) 用 `<<<ITEM_DATA>>>` 围栏 + 去围栏化防御，
   但围栏只是第一道，**模型本身的抗注入能力是第二道**。
5. 不需要的能力：长上下文（6000 字符封顶）、推理（摘要不是解题）、
   工具调用、多模态、超低延迟（GitHub Actions 里跑，多等 30 秒无所谓）。

> 换句话说：**这是一个「小输入 / 小输出 / 高频 / 重中文写作」的任务**，
> 旗舰模型的钱花在了这个任务用不上的维度上。

### 1.1 实测用量（读 `archive/2026/08/` 的 17 份归档算出来的）

`when.topPerSection: 3` 是真正的闸门——它把每期上模型的条数卡在「栏目数 × 3」：

| 期次    | 实测条目数 | 栏目数 | **上模型的条数**                   |
| ------- | ---------- | ------ | ---------------------------------- |
| morning | 15–22      | 4–6    | **10–16**（均值 12）               |
| evening | 14–19      | 4–6    | **9–14**（均值 11）                |
| news-am | 30         | 3      | **9**                              |
| news-pm | 30         | 3      | **9**                              |
| weekly  | 30         | 6      | **0**（条目是重印，只多 1 次导读） |

推出来的日用量：

```
每天调用次数 = 12 + 11 + 9 + 9  (条目)  +  4 (导读)  ≈ 45 次
每天输入     ≈ 109k 字符 ≈ 42k tokens   → 取 50k tokens（留余量）
每天输出     ≈ 45 × 140 tokens          → 取 8k tokens
──────────────────────────────────────────────────────────
每月         ≈ 1.5M 输入 tokens / 0.25M 输出 tokens
```

结构性上限在 [`policy.ts:212`](../src/enrich/policy.ts#L212)：
`maxItemsPerRun: 24` × `maxInputCharsPerItem: 6000` = 每期最多 144k 字符，
而 `maxTotalInputChars: 80000` 先一步封顶。**就算配置全写错，单期也烧不过 80k 字符。**
这是下面所有报价都可以放心乘的原因。

---

## 2. 国内大模型价格（2026-08-26）

| 供应商        | 模型                  | 输入 ¥/M                                       | 输出 ¥/M                             | 缓存命中             | 上下文 | 备注                               |
| ------------- | --------------------- | ---------------------------------------------- | ------------------------------------ | -------------------- | ------ | ---------------------------------- |
| **DeepSeek**  | `deepseek-v4-flash`   | **¥1.56**（$0.22 谷时）<br>¥3.12（$0.44 峰时） | **¥4.69**（$0.66）<br>¥9.37（$1.32） | $0.007/M（**1/31**） | 1M     | 峰时 = UTC 01–04 / 06–10，仅工作日 |
| DeepSeek      | `deepseek-v4-pro`     | ¥4.69（$0.66 谷时）                            | ¥14.1（$1.98）                       | $0.022/M             | 1M     | 同上                               |
| **阿里百炼**  | `qwen3.7-flash`       | **¥0.2**（≤32K 档）                            | **¥0.8**                             | ¥0.02                | 1M     | 阶梯计价：32K–256K 涨到 ¥0.6/¥2.4  |
| 阿里百炼      | `qwen3.7-plus`        | ¥2（限时 8 折）                                | ¥8（限时 8 折）                      | 有                   | 256K+  |                                    |
| 阿里百炼      | `qwen3.8-max`         | ¥12                                            | ¥36                                  | 有                   | 1M     |                                    |
| **智谱**      | `GLM-4.7-Flash`       | **免费**                                       | **免费**                             | —                    | 200K   | 长期免费；限并发不限量             |
| 智谱          | `GLM-4.7`             | ¥2（0–32K）                                    | ¥8，**输出 >200 tok 跳 ¥14**         | ¥0.4                 | 200K   | 本项目输出 ≈250 tok，会踩到 ¥14 档 |
| 智谱          | `GLM-5`               | ¥4（0–32K）                                    | ¥18                                  | ¥1                   | 200K   |                                    |
| 智谱          | `GLM-5.2`             | ¥8                                             | ¥28                                  | ¥2                   | 1M     | 不分档                             |
| **Moonshot**  | `Kimi K2.5`           | ¥4.26（$0.60）                                 | ¥21.3（$3.00）                       | $0.15/M              | 200K+  |                                    |
| Moonshot      | `Kimi K3`             | ¥21.3（$3.00）                                 | ¥106（$15.00）                       | $0.30/M              | 1M     |                                    |
| **火山/豆包** | `doubao-lite-128k`    | ¥0.8                                           | ¥1.0                                 | ¥1.2                 | 128K   |                                    |
| 火山/豆包     | `Doubao-Seed-2.1-pro` | ¥6                                             | ¥30                                  | 缓存读 ¥1.2          | —      | 首次开通送 50 万免费 token         |
| **MiniMax**   | `MiniMax-M3`          | ¥2.13（$0.30 促销）                            | ¥8.52（$1.20 促销）                  | 有                   | 512K   | 标价 $0.60/$2.40，「永久 5 折」    |

> 汇率按 **¥7.1 / $1** 折算。
> 智谱和阿里都改成了**按单次请求输入长度分段计价**——本项目单次输入 ≤6000 字符，
> **永远落在最便宜的第一档**，这是个结构性优势。

## 3. 海外大模型价格（2026-08-26）

| 供应商        | 模型                    | 输入 $/M            | 输出 $/M              | 上下文 | 备注                        |
| ------------- | ----------------------- | ------------------- | --------------------- | ------ | --------------------------- |
| **OpenAI**    | `gpt-5-nano`            | $0.05               | $0.40                 | —      |                             |
| OpenAI        | `gpt-5-mini`            | $0.25               | $2.00                 | —      |                             |
| OpenAI        | `gpt-5`                 | $1.25               | $10.00                | —      |                             |
| OpenAI        | `gpt-5.6 Luna`          | $0.20               | $1.20                 | —      | 2026-07-30 降价后           |
| OpenAI        | `gpt-5.6 Terra / Sol`   | $2 / $5             | $12 / $30             | —      | Sol 于 08-22 又降 20% / 33% |
| **Google**    | `gemini-2.5-flash-lite` | $0.10               | $0.40                 | —      | 现存最便宜档                |
| Google        | `gemini-3.1-flash-lite` | $0.25               | $1.50                 | —      |                             |
| Google        | `gemini-3.7-flash`      | $0.75               | $3.75                 | —      | **2027-01-01 翻倍**         |
| **Anthropic** | `claude-haiku-4-5`      | $1.00               | $5.00                 | 200K   |                             |
| Anthropic     | `claude-sonnet-5`       | $3.00（促销 $2.00） | $15.00（促销 $10.00） | 1M     | 促销至 2026-08-31           |
| Anthropic     | `claude-opus-5`         | $5.00               | $25.00                | 1M     |                             |

---

## 4. 按本项目真实用量折算的月成本

基准：**1.5M 输入 + 0.25M 输出 / 月**（§1.1）。

| 模型                      | 月成本             | 相对 DeepSeek Flash    |
| ------------------------- | ------------------ | ---------------------- |
| **GLM-4.7-Flash**         | **¥0**             | 免费                   |
| **qwen3.7-flash**         | **¥0.50**          | 0.14×                  |
| gpt-5-nano                | ¥1.28（$0.18）     | 0.37×                  |
| doubao-lite-128k          | ¥1.45              | 0.41×                  |
| gemini-2.5-flash-lite     | ¥1.78（$0.25）     | 0.51×                  |
| **deepseek-v4-flash**     | **¥3.51（$0.50）** | **1×（基准）**         |
| gpt-5.6 Luna              | ¥4.26（$0.60）     | 1.2×                   |
| qwen3.7-plus              | ¥5.00              | 1.4×                   |
| gpt-5-mini                | ¥6.25（$0.88）     | 1.8×                   |
| GLM-4.7                   | ¥6.50              | 1.9×                   |
| GLM-5                     | ¥10.5              | 3.0×                   |
| deepseek-v4-pro           | ¥10.6（$1.49）     | 3.0×                   |
| Kimi K2.5                 | ¥11.7（$1.65）     | 3.3×                   |
| gemini-3.7-flash          | ¥14.6（$2.06）     | 4.2×（明年 1 月 8.4×） |
| Doubao-Seed-2.1-pro       | ¥16.5              | 4.7×                   |
| GLM-5.2                   | ¥19.0              | 5.4×                   |
| claude-haiku-4-5          | ¥19.5（$2.75）     | 5.6×                   |
| Kimi K3 / claude-sonnet-5 | ¥58.6（$8.25）     | 16.7×                  |
| claude-opus-5             | ¥97.6（$13.75）    | 27.8×                  |

**读法**：从免费到最贵，全程差 **¥98/月**。

> 所以：**不要为了省 ¥10 挑一个中文写得差的模型，也不要为了「最强」付 28 倍
> 去做一件它用不上强项的事。**

### 4.1 一个白捡的便宜：DeepSeek 的峰谷时段和本项目的 cron 天然错开

DeepSeek 峰时 = **UTC 01:00–04:00 与 06:00–10:00，仅周一至周五**。
把 [`daily-brief.yml:7-11`](../.github/workflows/daily-brief.yml#L7-L11) 的四个 cron 摆进去：

| 期次    | UTC 触发 | 峰 / 谷                                   |
| ------- | -------- | ----------------------------------------- |
| morning | 23:10    | **谷时（半价）**                          |
| evening | 12:10    | **谷时（半价）**                          |
| news-pm | 10:10    | **谷时**（峰时 10:00 刚结束，差 10 分钟） |
| news-am | 01:10    | 峰时（工作日）                            |

**四期里三期半价，唯一踩峰时的 news-am 恰好是最便宜的一期**
（`oneline` 风格、不抓正文、只喂 ≈100 字符 excerpt）。§4 的 ¥3.51 已按这个结构算过。

这不是刻意设计的，但它是真实的，**并且是「改 cron 时间」这个动作会悄悄破坏的东西**：
把 morning 从 07:10 挪到 09:10 CST，它就滑进 UTC 01:10 的峰时——而那一期恰恰是最贵的一期。
记在这里，免得将来调时间时踩到。

---

## 5. 硬约束：能不能接进来，比多少钱重要得多

[`llm.ts`](../src/enrich/llm.ts) 是刻意写死的最小 OpenAI 兼容客户端——
一次 POST，`/chat/completions`，body 里固定发这几个字段（[`llm.ts:110-124`](../src/enrich/llm.ts#L110-L124)）：

```jsonc
{ "model": …, "temperature": 0, "max_tokens": 300, "messages": [system, user] }
```

配置里写的承诺是「**换供应商不需要改代码**」（[`brief.config.yaml`](../brief.config.yaml) §llm.provider）。
拿这个契约去卡候选人，一半直接出局：

| 供应商               | `/chat/completions`         | `temperature: 0`                | `max_tokens`                      | 判定                             |
| -------------------- | --------------------------- | ------------------------------- | --------------------------------- | -------------------------------- |
| DeepSeek             | ✅ 原生                     | ✅                              | ✅                                | **零改动**                       |
| 阿里百炼（兼容模式） | ✅                          | ✅                              | ✅                                | **零改动**                       |
| 智谱 BigModel        | ✅                          | ✅                              | ✅                                | **零改动**                       |
| Moonshot / Kimi      | ✅                          | ✅                              | ✅                                | **零改动**                       |
| 火山方舟 / 豆包      | ✅                          | ✅                              | ✅                                | 零改动（但 model 要填接入点 ID） |
| MiniMax              | ✅                          | ✅                              | ✅                                | 零改动                           |
| **OpenAI GPT-5 系**  | ✅                          | ❌ **只接受 1**                 | ❌ **要 `max_completion_tokens`** | **要改 llm.ts，两处 400**        |
| **Google Gemini**    | ⚠️ 兼容层 `/v1beta/openai/` | ✅                              | ✅                                | 能跑，但兼容层有已知偏差         |
| **Anthropic Claude** | ❌ 自有 `/v1/messages`      | ❌ Opus 5 / Sonnet 5 **已移除** | ❌ 无同名语义                     | **要网关或重写客户端**           |

三条具体的坑，写清楚免得将来有人试：

1. **GPT-5 家族会 400 两次**。`max_tokens` 报 `Unsupported parameter`，
   `temperature: 0` 报 `Only the default (1) value is supported`。
   而 `temperature: 0` 在这个项目里不是随手写的——配置注释说得很清楚：
   **「同样的输入永远给同样的输出，便于 `--re-enrich` 比对」**。
   为了接 GPT-5 放弃可复现性，不划算。
2. **Claude 的 4.6+ 世代整体移除了 `temperature` / `top_p`**，同样和 `--re-enrich` 的可复现性冲突。
   加上它根本不是 OpenAI 兼容端点，接进来等于推翻决策 1。
3. **豆包的 `model` 字段填的是「推理接入点 ID」**（`ep-2024…`）而不是模型名，
   这会让 `LLM_MODEL` 这个变量从「模型名」变成一串 ID，可读性直接崩掉。

> 这一节的结论：**决策 1「任意 OpenAI 兼容端点」这个设计，事实上已经把选型范围
> 收敛到了国产模型 + Gemini。** 而这恰好和 §1 的任务画像（重中文写作）指向同一个方向——
> 这是运气好，不是必然。

---

## 6. 逐个说优劣（只谈跟这个项目有关的维度）

### DeepSeek `deepseek-v4-flash` —— 推荐主力

- ✅ **中文摘要是它的舒适区**。英→中压缩不带翻译腔，而这是读者唯一能感知的东西。
- ✅ **配置已经指向它**（`baseUrl` 就是 `api.deepseek.com/v1`），只需改模型名一个词。
- ✅ **缓存命中价 $0.007/M = 未命中的 1/31**，是全场最激进的缓存折扣。
  本项目不做摘要缓存层（决策 10），但 system prompt 是逐条重复的固定前缀，
  DeepSeek 的自动前缀缓存会白送一部分折扣。
- ✅ 峰谷错位白捡半价（§4.1）。
- ✅ 官方并发 50 路，而配置里 `concurrency: 4`，完全不紧张。
- ⚠️ **`deepseek-chat` 已死**。2026-07-24 15:59 UTC 起该别名不再解析。
  迁移映射：`deepseek-chat` → `deepseek-v4-flash`（关闭思考），
  `deepseek-reasoner` → `deepseek-v4-flash`（开启思考），**不是** v4-pro。

### 智谱 `GLM-4.7-Flash` —— 推荐做零成本兜底 / A-B 对照

- ✅ **永久免费**，200K 上下文，30B-A3B MoE，支持函数调用与流式。
- ✅ 中文原生，摘要任务上和付费小模型差距不明显。
- ⚠️ **限并发不限量**——免费档卡的是 RPM / 并发，不是 token。
  本项目每期 45 次调用、并发 4，量级上不该撞限流；即使撞了，
  [`llm.ts`](../src/enrich/llm.ts) 对 429 重试两次后降级回 excerpt——
  **不会挂，只会那条没摘要**。这正是决策 6 的价值。
- ⚠️ 免费档的模型迭代不由你控制：`GLM-4.5-Flash` 已于 2026-01-30 下线并自动路由到 4.7-Flash。
  免费的东西可以被停掉，所以它适合当**兜底和对照组**，不适合当唯一主力。

### 阿里 `qwen3.7-flash` / `qwen3.7-plus` —— 推荐做升级档

- ✅ **`qwen3.7-flash` 是全场最便宜的付费选项（¥0.50/月）**，
  且阶梯计价的第一档（≤32K）正好完全覆盖本项目的输入规模。
- ✅ **官方文档明确标注支持结构化输出**，对 [`sanitize.ts`](../src/enrich/sanitize.ts) 的 JSON 解析是加分项。
- ✅ 缓存命中 ¥0.02/M，同样激进。
- ✅ 第三方横评里吞吐与成功率均为几家最高（P50 290ms、成功率 99.8%）。
- ⚠️ **阶梯计价是把双刃剑**：若哪天把 `maxInputCharsPerItem` 从 6000 提到 100000+，
  会静默跳到 32K–256K 档，单价 ×3。这个改动看起来只影响「摘要质量」，实际还影响单价。
- ⚠️ 百炼的 OpenAI 兼容端点和原生端点是两个 baseUrl，配错会 404。

### Moonshot Kimi

- ✅ 长文本理解口碑好，中文写作扎实，工具调用准确率提升明显。
- ❌ **和它的强项对不上**：本项目输入封顶 6000 字符，长上下文优势完全用不到，
  却要按 K2.5 ¥11.7/月（3.3×）或 K3 ¥58.6/月（16.7×）付钱。

### 火山豆包

- ✅ `doubao-lite-128k` ¥1.45/月很便宜，首开还送 50 万 token。
- ❌ **`model` 字段要填推理接入点 ID**，破坏 `LLM_MODEL` 这个变量的语义（§5 第 3 条）。
- ❌ `Doubao-Seed-2.1-pro` 输出 ¥30/M 是国产里最贵的输出价之一，性价比不成立。

### OpenAI GPT-5 系

- ✅ `gpt-5-nano` ¥1.28/月确实便宜；指令遵从和 JSON 稳定性是行业标杆（原生 `json_schema` 严格模式）。
- ❌ **两个参数都会 400**（§5 第 1 条），要动 [`llm.ts`](../src/enrich/llm.ts)。
- ❌ **中文摘要仍带翻译腔**，而这是本项目唯一的输出形态。

### Google Gemini

- ✅ `gemini-2.5-flash-lite` ¥1.78/月，有 OpenAI 兼容层，理论上零改动。
- ⚠️ 兼容层有**已知不合规**（流式每 chunk 都返回 usage 等）。本项目非流式调用暂不受影响，
  但它是「兼容层」而非原生契约，将来的偏差不可控。
- ❌ `gemini-3.7-flash` **2027-01-01 价格翻倍**，`gemini-2.5-flash` 2026-10-16 弃用——
  产品线变动比国产家快，对一个「配好就不想再管」的每日任务不是好事。

### Anthropic Claude

- ✅ **指令遵从与抗提示注入是全场最强**。§1 第 4 条（不可信 RSS 正文直接进公开仓库 + 群发邮件）
  是这个项目唯一真正的安全面，Claude 在这一维度确实值溢价。
- ❌ **不是 OpenAI 兼容端点**，接进来要写网关或重写 [`llm.ts`](../src/enrich/llm.ts)，推翻决策 1。
- ❌ 4.6+ 世代移除 `temperature`，和 `--re-enrich` 的可复现性诉求冲突。
- ❌ Opus 5 ¥97.6/月 = DeepSeek 的 **27.8 倍**，买来的能力（长程推理、agentic）本项目一样都用不上。
- 💡 **保留意见**：将来若「全刊导读」要做成真正的主编视角（跨条目找关联、给判断而不是复述），
  可以**只给导读那一次调用换成 Claude**——每天 4 次、每次 ≈4.5k 字符，单独走 Claude 月成本不到 ¥3。
  [`digest.ts`](../src/enrich/digest.ts) 是独立调用点，技术上支持「条目用便宜模型、导读用贵模型」，
  但当前 [`schema.ts`](../src/config/schema.ts) 只有一个 `provider`，要做得先加一个 `digest.provider` 覆盖。
  **现在不做，记在这里。**

---

## 7. 落地步骤

### 7.1 必做：修掉那个已死的模型名

```yaml
# brief.config.yaml §llm.provider
model: deepseek-v4-flash # was: deepseek-chat（2026-07-24 已退役，会 404）
```

> 这一条**和配不配 key 无关，现在就该改**。留着 `deepseek-chat` 的唯一后果是：
> 将来某天有人把 key 加进 secrets，然后花半小时排查为什么早报里一条摘要都没有——
> 而运行页只会说「LLM 失败 N 条」，不会说「模型名不存在」。

### 7.2 配 secrets / vars

| 名字           | 类型           | 值                                                    |
| -------------- | -------------- | ----------------------------------------------------- |
| `LLM_API_KEY`  | **secret**     | DeepSeek 控制台的 key（`apiKeyRef` 指的就是这个名字） |
| `LLM_BASE_URL` | secret（可选） | 只在换供应商时设                                      |
| `LLM_MODEL`    | vars（可选）   | 只在换供应商时设，**必须和 `LLM_BASE_URL` 成对改**    |

[`llm.ts:76`](../src/enrich/llm.ts#L76) 的 `resolveProvider` 已经实现了这个覆盖语义，不用改代码。

### 7.3 第一天先手动跑一次，别直接上定时

先手动触发一次 `morning`，然后检查三件事：

1. `archive/2026/08/<date>.morning.json` 里的条目**同时有 `excerpt` 和 `summary`**
   （决策 5：不覆写 `excerpt`，两个都在——这是事后评估 prompt 的唯一依据）。
2. `warnings` 里没有成批的 LLM 失败。零星几条正常（付费墙、JS 壳）。
3. `summary` 的长度贴着 180 / 220，而不是被 [`sanitize.ts`](../src/enrich/sanitize.ts) 截在半句。
   **贴边截断 = 模型不遵守字数**，这是换模型的信号。

### 7.4 想 A-B 对照时（这是免费的）

`GLM-4.7-Flash` 不要钱，所以对照组的成本是零：

```
LLM_BASE_URL = https://open.bigmodel.cn/api/paas/v4
LLM_MODEL    = glm-4.7-flash
```

跑一期，再用 `--re-enrich` 对同一批归档条目重跑一次。
因为 `temperature: 0` 且 [`prompt.ts:8`](../src/enrich/prompt.ts#L8) 的 `PROMPT_VERSION` 会一起归档，
**这个对照能干净地把「模型换了」和「提示词换了」分开**——
这正是当初把 `PROMPT_VERSION` 写进归档的理由。

### 7.5 什么时候该升级

只在**看到具体症状**时升，不要因为「听说 X 更强」而升：

| 症状                                | 换成                                                  |
| ----------------------------------- | ----------------------------------------------------- |
| 摘要总在半句被截断（不守字数）      | `qwen3.7-plus`（¥5/月）——指令遵从档次差别最明显       |
| `takeaways` 经常整批消失（JSON 崩） | `qwen3.7-flash`（¥0.5/月，官方标注支持结构化输出）    |
| 英文长文的中文摘要读着像机翻        | `deepseek-v4-pro`（¥10.6/月）                         |
| 导读像目录朗读，不像主编的话        | 单独给 `digest` 换模型（需先扩 schema，§6 Claude 段） |

---

## 8. 数据来源

价格页（一手）：

- [DeepSeek 官方定价](https://api-docs.deepseek.com/quick_start/pricing/)
- [阿里云百炼模型价格](https://help.aliyun.com/zh/model-studio/model-pricing) · [qwen3.7-flash 模型页](https://help.aliyun.com/zh/model-studio/qwen3-7-flash)
- [智谱 BigModel 模型总览](https://docs.bigmodel.cn/cn/guide/start/model-overview) · [定价页](https://open.bigmodel.cn/pricing)
- [Kimi 开放平台定价](https://platform.kimi.com/docs/pricing/chat)
- [火山引擎 Doubao-Seed-2.1-pro 定价](https://www.volcengine.com/article/2605348)
- [MiniMax 按量计费](https://platform.minimaxi.com/docs/guides/pricing-paygo)
- [Gemini OpenAI 兼容层](https://ai.google.dev/gemini-api/docs/openai)
- Anthropic 价格取自 `claude-api` skill 内缓存表（2026-06-24），与官方定价页一致

二手交叉验证：

- [DeepSeek 别名退役迁移指南](https://www.developersdigest.tech/blog/deepseek-chat-to-v4-migration-guide) · [另一份](https://deepseekv4pro.com/guides/deepseek-chat-reasoner-retirement-date)
- [OpenAI API Pricing (Aug 2026)](https://benchlm.ai/openai/api-pricing) · [Morph 汇总](https://www.morphllm.com/openai-api-pricing)
- [Gemini API Pricing 2026](https://www.morphllm.com/gemini-api-pricing) · [CloudZero](https://www.cloudzero.com/blog/gemini-pricing/)
- [Kimi API Pricing (Aug 2026)](https://benchlm.ai/moonshot/api-pricing)
- [智谱 GLM 计费拆解（2026-08-09）](https://iqilian.com/learn/glm-api-jifei/)
- [国产大模型 API 横评：并发 / 延迟实测](https://www.holysheep.cn/articles/zh-guochandamoxing-api-hengpingdeepseek-v4-kimi-glm-5-2026-07-02-0003.html)
- GPT-5 参数限制：[litellm #13381](https://github.com/BerriAI/litellm/issues/13381) · [graphiti #874](https://github.com/getzep/graphiti/issues/874)

> **价格会变。** 智谱 2026 年内 API 价格涨超八成、GLM-5 发布时 API 涨价 67%–100%、
> Gemini 3.7-flash 明年 1 月翻倍、DeepSeek 有峰谷两套价——
> 这张表的有效期按月算，不按年算。真要动钱的决定，回本节的一手链接复核。

---

## 9. 三强候选的能力对比：长上下文 / 推理 / 工具调用

> 补充于 2026-08-26。§0 的推荐只按「当前任务」（小输入 / 小输出 / 重中文写作）选型。
> 本节回答另一个问题：**后续要加功能时，这三个模型各自能撑到哪里，以及换模型的代价有多大。**
> 候选收敛为 `GLM-4.7-Flash` / `qwen3.7-flash` / `deepseek-v4-flash`。

### 9.1 能力矩阵

| 维度                   | **GLM-4.7-Flash**                                                           | **qwen3.7-flash**                                                        | **deepseek-v4-flash**                                                 |
| ---------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------- |
| 上下文窗口             | 200K 入 / **128K 出**                                                       | **1M**（991,808 入 / 131,072 出）                                        | **1M**（最大输出 384K）                                               |
| 长上下文的**价格结构** | 免费，**不分档**                                                            | ⚠️ **阶梯计价**：≤32K ¥0.2/¥0.8 → 32K–256K ¥0.6/¥2.4 → 256K–1M ¥1.2/¥4.8 | **单一价，不分档**                                                    |
| 推理 / 深度思考        | ✅                                                                          | ✅                                                                       | ✅                                                                    |
| 开启思考的参数         | `thinking: {"type":"enabled"}`                                              | `enable_thinking: true`<br>`thinking_budget: 1–32768`                    | `thinking: {"type":"enabled"}`<br>`reasoning_effort: "high"`          |
| 推理实测               | AIME25 **91.6**／SWE-bench V **59.2**／τ²-Bench **79.5**（同尺寸开源 SOTA） | 商业版混合思考模式，CoT 上限 262,144 tok                                 | V4 世代 284B，思考模式与 v4-pro 同源                                  |
| 工具调用               | ✅ **+ 原生 MCP**                                                           | ✅ Function Calling（全地域）                                            | ✅（V3.2 起）**且思考模式下可用**                                     |
| 工具调用参数           | `tools` / `tool_choice`（**标准 OpenAI**）                                  | `tools`（**标准 OpenAI**）                                               | `tools`（**标准 OpenAI**）+ beta 端点 `strict: true`                  |
| 结构化输出             | ✅ 结构化输出                                                               | ✅ 结构化输出（json_schema）                                             | ⚠️ **仅 `json_object`，无 `json_schema`**，官方承认「偶尔返回空内容」 |
| 视觉                   | ❌ 纯文本                                                                   | ✅ 图像 / 文本 / 视频                                                    | ⚠️ 需换模型 `deepseek-v4-flash-vision-exp`                            |
| 内置联网搜索           | ❌（可走 MCP）                                                              | ✅ 北京 / 新加坡地域                                                     | ❌                                                                    |
| 上下文缓存             | ✅                                                                          | ✅ ¥0.02–0.04/M                                                          | ✅ $0.007/M（未命中的 **1/31**）                                      |
| **并发**               | ⚠️ **免费档 ≈1 QPS**                                                        | 商业档，无实质限制                                                       | 官方 **50 路**                                                        |
| 月成本（本项目用量）   | **¥0**                                                                      | **¥0.50**                                                                | **¥3.51**                                                             |

### 9.2 结论一：三个能力全都支持——但只有「工具调用」是可移植的

这是本节最重要的一句话：

- **`tools` / `tool_choice` 三家都是标准 OpenAI 形状** → 加工具调用**不需要为不同厂商写分支**，
  换模型时这部分代码原样不动。
- **思考模式三家三种写法**（见上表）→ **不可移植**。`LLM_MODEL` 换一个值，
  思考模式的参数必须同时换，否则要么静默不生效，要么 400。
  这直接违反 [`brief.config.yaml`](../brief.config.yaml) §llm.provider 那条注释的精神：
  「二者必须成对改」——将来会变成「**三者**必须成对改」。
- **长上下文根本不是参数问题**，是 [`brief.config.yaml`](../brief.config.yaml) 里
  `maxInputCharsPerItem` / `maxTotalInputChars` 两个数字的问题，三家都够用（§9.4）。

### 9.3 结论二：`llm.ts` 现在挡住了上面全部三种能力——但只差 5 行

[`llm.ts:110-124`](../src/enrich/llm.ts#L110-L124) 的 body 是**写死的四个字段**：

```jsonc
{ "model": …, "temperature": 0, "max_tokens": 300, "messages": […] }
```

`thinking` / `enable_thinking` / `tools` 一个都传不出去。但注意一件事：

> **`llm.ts` 用的是裸 `fetch` + `JSON.stringify`，不是任何厂商 SDK。**
> 所以厂商扩展参数对它而言只是 JSON body 里多几个 key ——
> 不存在 Python SDK 那种「非标参数必须塞进 `extra_body`」的问题。

这是当初「刻意不用 vendor SDK」（[`llm.ts:3-9`](../src/enrich/llm.ts#L3-L9)）的意外红利。
**加一个透传字段就能一次性解锁三家的全部扩展能力**，且不破坏决策 1：

```ts
// src/config/schema.ts —— LlmConfig['provider'] 增加
extraBody?: Record<string, unknown>   // 厂商扩展参数原样并入请求体

// src/enrich/llm.ts:118 附近
body: JSON.stringify({
  model: provider.model,
  temperature: provider.temperature,
  max_tokens: provider.maxOutputTokens,
  messages: [...],
  ...provider.extraBody,          // ← 唯一新增的一行
}),
```

配好之后，换厂商开思考模式就是改配置：

```yaml
# DeepSeek
provider:
  { model: deepseek-v4-flash, extraBody: { thinking: { type: enabled }, reasoning_effort: low } }
# Qwen
provider: { model: qwen3.7-flash, extraBody: { enable_thinking: true, thinking_budget: 2048 } }
# GLM
provider: { model: glm-4.7-flash, extraBody: { thinking: { type: enabled } } }
```

> **建议现在就加这 5 行**，哪怕暂时不开思考模式。
> 理由和 §7.1 一样：它把「将来要不要用某个能力」从**改代码**降级成**改配置**，
> 而这正是 §llm 那一整块配置存在的意义。

### 9.4 真开这些能力时，会踩到的四个坑

1. **`maxOutputTokens: 300` 会被思维链吃掉。**
   思考模式下 CoT 也算输出 token（三家都是这样计费的）。300 的上限会让模型
   「想完就没预算写答案了」，表现为 `finish_reason: length` + 空摘要。
   开思考模式必须同步把这个数抬到 2000+。
2. **`timeoutMs: 30000` 对思考模式偏紧。** qwen3.7-flash 的 CoT 上限是 262,144 token，
   GLM-4.7-Flash 最大输出 128K。30 秒会大面积超时，然后
   [`llm.ts:170`](../src/enrich/llm.ts#L170) 把超时判为可重试 → 重试两次 → 一期跑 90 秒还是失败。
3. **非流式 + 思考模式。** [`llm.ts`](../src/enrich/llm.ts) 不发 `stream: true`。
   通义**商业版**（含 qwen3.7-flash）支持非流式思考，但**开源版**会直接报
   `parameter.enable_thinking only support stream call`。
   将来如果为了省钱换成开源版模型名，这里会炸。
4. ⚠️ **GLM 免费档 ≈1 QPS，而 [`brief.config.yaml`](../brief.config.yaml) 写的是 `concurrency: 4`。**
   直接开跑会成片 429。用 GLM-4.7-Flash **必须同时把 `llm.concurrency` 和
   `extract.concurrency` 降到 1**。好消息是量能扛得住：每期 ≈12 次调用，
   串行 5 秒一次也就 1 分钟，仍在 [`daily-brief.yml`](../.github/workflows/daily-brief.yml) 的时间账里。
   （1 QPS 这个数字来自社区实测，智谱官方文档未公布具体 RPM/TPM，配之前建议在控制台确认。）

### 9.5 按「将来想加什么功能」倒推该选谁

| 将来想加的功能                                                 | 最合适                                     | 为什么                                                                                                   |
| -------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| **让模型自己调工具**（查 GitHub star、核对版本号、抓补充资料） | **GLM-4.7-Flash**                          | τ²-Bench 79.5 是三者最高，且**原生 MCP**——将来接现成工具生态不用自己写 adapter；免费                     |
| **月报 / 季报的跨期归纳**（几百条标题一次喂进去）              | **qwen3.7-flash** 或 **deepseek-v4-flash** | GLM 200K 也够（30 天 ≈510 条 ≈30k token），但 1M 留的余量更大；⚠️ qwen 超 32K 后单价 ×3，deepseek 不分档 |
| **给条目做判断而非复述**（真正的主编视角导读）                 | **deepseek-v4-flash**（思考模式）          | 中文写作仍是它最强；思考模式下还能同时用工具                                                             |
| **更严格的 JSON**（让 `takeaways` 不再整批消失）               | **qwen3.7-flash**                          | 三者中唯一明确支持 `json_schema`；DeepSeek 只有 `json_object` 且官方承认有空内容 bug                     |
| **给条目配图 / 读截图**                                        | **qwen3.7-flash**                          | 唯一原生多模态（图像/文本/视频）；DeepSeek 要换模型，GLM 纯文本                                          |
| **让模型自己联网补背景**                                       | **qwen3.7-flash**                          | 唯一内置服务端联网搜索，不用自己搭工具                                                                   |

### 9.6 修正后的结论

§0 的推荐**不变**，但理由要补一条，并且候选的定位要调整：

| 模型                  | 定位                               | 一句话                                                                                                                                                                                                                                                             |
| --------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **deepseek-v4-flash** | **仍是主力**                       | 中文写作最强 = 当前唯一的输出形态；1M 不分档；缓存 1/31；峰谷白捡半价。**短板是结构化输出**（无 `json_schema` + 空内容 bug），但本项目目前根本没用 `response_format`（靠提示词 + [`sanitize.ts`](../src/enrich/sanitize.ts) 宽松解析），所以这个短板**今天不咬人** |
| **GLM-4.7-Flash**     | **从「兜底」升格为「能力对照组」** | 之前只当免费兜底，但它在**工具调用 + MCP + 推理分数**上其实是三者最强，而且免费。真要加 agent 类功能，它是第一个该试的。**代价是 1 QPS 和「免费的可以被停掉」**                                                                                                    |
| **qwen3.7-flash**     | **能力面最宽的付费选项**           | 1M 上下文 + 视觉 + 内置搜索 + `json_schema`，月成本 ¥0.5（比 DeepSeek 还便宜 7 倍）。**如果将来的功能明确要多模态或联网，直接选它，不用犹豫**                                                                                                                      |

> **但这三个的月成本合计 ¥4。**
> 所以真正该做的不是现在把三选一想清楚，而是先加 §9.3 那 5 行透传——
> **把「选哪个」从架构决策降级成一行配置**，然后用免费的 GLM 跑对照组去验证，
> 哪个好就留哪个。这比现在纸上推演划算得多。

---

## 10. 已落地：透传 + GLM 对照组（2026-08-26）

§9.3 提的那几行已经实现。这一节记录**改了什么**和**怎么跑对照组**。

### 10.1 代码改动

| 文件                                                                        | 改动                                                                            | 为什么                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------- |
| [`src/config/schema.ts`](../src/config/schema.ts)                           | `provider.model` 默认值 `deepseek-chat` → **`deepseek-v4-flash`**               | 旧别名 2026-07-24 下线，配上密钥的那天起每天四个 404 |
| [`src/config/schema.ts`](../src/config/schema.ts)                           | 新增 `provider.extraBody: Record<string, unknown>`，默认 `{}`                   | 厂商扩展参数的落脚点                                 |
| [`src/config/schema.ts`](../src/config/schema.ts)                           | `extraBody` 拒绝 `model` / `messages` / `temperature` / `max_tokens` / `stream` | 见 §10.2                                             |
| [`src/enrich/llm.ts`](../src/enrich/llm.ts)                                 | 请求体末尾 `...provider.extraBody`                                              | 唯一一行真正的透传                                   |
| [`src/enrich/llm.ts`](../src/enrich/llm.ts)                                 | `resolveProvider()` 新增 `LLM_CONCURRENCY` 覆盖                                 | 见 §10.3                                             |
| [`brief.config.yaml`](../brief.config.yaml)                                 | 修模型名 + `extraBody: {}` + 三家写法的注释                                     | 配置本身就是文档                                     |
| [`.github/workflows/daily-brief.yml`](../.github/workflows/daily-brief.yml) | `env:` 加 `LLM_CONCURRENCY`                                                     | 换到限流更紧的密钥时不用改代码                       |
| [`README.md`](../README.md) / [`LLM-SUMMARY.md`](./LLM-SUMMARY.md)          | 同步                                                                            | —                                                    |

请求体现在长这样，四个受管字段一个没动：

```jsonc
{ "model": …, "temperature": 0, "max_tokens": 300, "messages": […], /* …extraBody */ }
```

**决策 1 不变**：`llm.ts` 仍然是一次 `POST /chat/completions`，仍然没有任何厂商 SDK。
换模型、开思考模式、加工具调用，从此都是**改配置**，不是改代码。

### 10.2 为什么 `extraBody` 有五个键是禁用的

前四个（`model` / `messages` / `temperature` / `max_tokens`）由 `provider` 自己管。
允许 `extraBody` 覆盖它们，等于让配置**不再是实际计费内容的记录**——
`maxOutputTokens: 300` 写在那儿，实际发出去的却是别的数，运行汇总和归档全部对不上。

第五个 `stream` 是另一种事故：[`llm.ts`](../src/enrich/llm.ts) 只把响应体
`JSON.parse` 一次，收到 SSE 会判成 `endpoint returned a non-JSON body` ——
**整期条目全部退回 excerpt**，而且因为不是 HTTP 错误，看起来像模型质量问题。

这五个键写进配置会在 `--validate-only` 阶段就报错，不会等到早上七点。

### 10.3 为什么顺手加了 `LLM_CONCURRENCY`

§9.4 第 4 条那个坑：GLM 免费档 ≈1 QPS，而配置写的是 `concurrency: 4`。
限流是**密钥的属性，不是代码的属性**——换个 key 就换个限流。跑对照组时如果因为
429 让一半条目退回 excerpt，比的就不是模型了，是重试运气。

取值非整数、越界（<1 或 >16）一律**忽略而不是报错**：一个写错的环境变量不该让早报停摆。

### 10.4 GLM 对照组怎么跑

用现成的 `--re-enrich`：读归档、重新摘要、**只打印，不发送不写盘**。
`temperature: 0` 保证同输入同输出，所以两次跑的差异只来自模型本身。

```bash
# A：现在的主力
LLM_API_KEY=<deepseek key> pnpm brief --re-enrich 2026-08-26 --diff

# B：免费对照组（注意 LLM_CONCURRENCY=1）
LLM_API_KEY=<glm key> \
LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4 \
LLM_MODEL=glm-4.7-flash \
LLM_CONCURRENCY=1 \
pnpm brief --re-enrich 2026-08-26 --diff
```

跑之前先 `pnpm brief --llm-dry-run` 看一眼会调几条、估多少 token，再花钱。

**看什么**（`--diff` 左边是原始 excerpt，右边是新摘要）：

1. **中文是不是人话** —— 英文源直出中文最容易露馅，这是当前唯一的输出形态
2. **`takeaways` 有没有整批消失** —— 没用 `response_format`，全靠提示词 + [`sanitize.ts`](../src/enrich/sanitize.ts) 宽松解析，模型不听话这里就空
3. **有没有编造** —— 摘要里的数字/版本号能不能在 excerpt 里对上
4. **`maxChars` 有没有被无视** —— oneline 栏目尤其明显
5. **失败率** —— 退回 excerpt 的条数；GLM 这边如果还高，说明 1 QPS 也不够，得看控制台的真实配额

哪个好就把 `brief.config.yaml` 的 `model` 改成哪个。**成本不参与这个决定**——
两者月成本分别是 ¥3.51 和 ¥0，差额买不到一杯咖啡，只有输出质量值得比。
