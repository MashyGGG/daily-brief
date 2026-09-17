# 技术雷达信息源接入实施记录（2026-09-17）

## 1. 范围

依据 `docs/Tech_Radar_Source_Collection_Spec_2026.md` 接入 15 个技术信息源。此次只调整
`morning` / `evening` 使用的 `tech`、`ai`、`cn-tech` 三栏及其采集基础设施；没有修改
`news-am` / `news-pm` 的栏目、源、权重、限额、时间和收件人。

周报和发布任务不发起这些新增网络请求，但它们读取早晚报归档，因此后续内容会自然反映
早晚报源的变化。

## 2. 实施前发现

- 项目只支持 `rss`、HN Algolia 和 GitHub Search 三类采集器。
- 规范 15 个源中已有 8 个，缺少 TLDR AI、TLDR Tech、Google Developers、Stack
  Overflow Blog、JavaScript Weekly、Changelog、V2EX。
- 已有 HN、GitHub、Anthropic 与规范抓取方式不一致；OpenAI 和 Hugging Face 覆盖不完整。
- 单次 HTTP 请求没有采集重试；无日期页面没有可持久化的增量状态。
- 项目 `weight` 的既有范围是 0.7–1.3，不能直接混入规范的 72–100。

## 3. 采集基础设施改造

### 3.1 逻辑源与主备策略

新增 `composite` 类型。一个逻辑源可以包含多个互补 stream；每个 stream 有一个 primary 和
若干 fallback。互补 stream 合并，fallback 按顺序尝试。这样主备入口仍只占一个栏目席位，
不会被 `minPerSource: 1` 当成两个媒体。

触发 fallback 的条件包括请求失败、非 2xx、解析异常，以及非增量策略解析为 0 条。

### 3.2 HTML 和增量 Diff

新增明确 profile 的轻量 HTML 解析器，当前覆盖 OpenAI News / Models、Claude Release Notes、
TLDR AI / Tech、Hugging Face Blog 和 JavaScript Weekly。解析规则按站点隔离；selector 变化产生
抓取告警，不会静默成功。

无发布日期的目录使用 URL ID 做增量 Diff。全部观察到的 ID 写入
`archive/source-state.json`：首次建立全量基线且只发最新一条，之后只发新 URL。dry-run 不写状态。
Google Developers 官方 Feed 当前没有 item 日期，也使用这一机制，避免历史文章每次被盖上运行时间。

### 3.3 API 与容错

- HN：官方 Firebase `topstories/item` 为主，最多 8 并发；Algolia 为 fallback。
- GitHub：Trending HTML 与 REST Search 并行合并；任一路失败，另一路仍可出结果。
- V2EX：配置 `V2EX_TOKEN` 时使用 API 2.0；未配置或调用失败时回退公开 v1 节点接口。
- 技术雷达源配置两次重试，退避为 250ms、500ms；新闻源维持原行为。
- JavaScript Weekly 和阮一峰只在 Asia/Shanghai 的周五抓取。

## 4. 信息源最终映射

| 逻辑源              | 规范分 | 主方案                                                 | 备选 / 补充                 |
| ------------------- | -----: | ------------------------------------------------------ | --------------------------- |
| OpenAI              |    100 | 官方 News RSS + Models 页面 Diff                       | News HTML                   |
| Anthropic           |    100 | Platform Release Notes HTML + Claude Code Release Atom | RSSHub 仅作平台流备选       |
| Hacker News         |     96 | 官方 Firebase API                                      | Algolia API                 |
| GitHub              |     96 | Trending HTML + REST Search 合并                       | 两路互为降级结果            |
| TLDR AI             |     88 | Archive HTML                                           | —                           |
| TLDR Tech           |     84 | Archive HTML                                           | —                           |
| InfoQ               |     86 | Architecture RSS                                       | 保持原实现                  |
| Google Developers   |     90 | 官方 RSS URL 增量                                      | —                           |
| Hugging Face        |     90 | 官方 RSS                                               | Blog HTML                   |
| Lobsters            |     78 | RSS                                                    | 保持原实现                  |
| Stack Overflow Blog |     76 | 官方 RSS                                               | —                           |
| JavaScript Weekly   |     76 | 官方 RSS                                               | Issues HTML                 |
| Changelog           |     78 | 官方 Feed                                              | —                           |
| V2EX                |     72 | API 2.0                                                | 公开 v1 节点 API            |
| 阮一峰周刊          |     82 | HTTP Atom                                              | HTTPS 实测 403，故保持 HTTP |

新增 7 个逻辑源后，项目共有 85 个源：75 RSS、7 composite、1 hackernews、1 github、
1 v2ex。技术栏目源数变为 `tech=22`、`ai=8`、`cn-tech=10`，栏目限额仍为 6、4、5；
加上 security 2 条，技术早晚报的结构性上限仍为 17 条。

## 5. 权重落地

Schema 新增 `sourceScore`（0–100），保留 `weight` 作为项目自身的编辑偏好。排序使用：

```text
effectiveWeight = weight × sourceScore / 80
```

80 是中性点；未声明 `sourceScore` 的旧源完全保持原权重。规范中的 15 个源统一使用
`weight: 1.0`，因此 100、96、90、88、86、84、82、78、76、72 分依次映射为
1.25、1.20、1.125、1.10、1.075、1.05、1.025、0.975、0.95、0.90。

没有在本次直接实现规范的完整六维评分公式；相关性、权威性、新颖性和惩罚项需要新的可解释
字段和标注数据，贸然替换会使全部历史 `rankScore` 不再可比。本次只落实规范明确给出的源权重。

## 6. 配置与代码变更

- `src/config/schema.ts`：新增 sourceScore、重试、星期约束、composite、v2ex 配置。
- `src/sources/composite.ts`：互补流合并与主备切换。
- `src/sources/html.ts`：站点 profile HTML 解析。
- `src/sources/v2ex.ts`：V2EX 2.0 / v1 回退。
- `src/sources/hackernews.ts`：Firebase 主方案与 Algolia fallback。
- `src/sources/github.ts`：Trending + Search 合并。
- `src/sources/types.ts`：按源重试和指数退避。
- `src/core/pipeline.ts`：星期过滤及 `archive/source-state.json` 读写。
- `src/core/rank.ts`：规范权重归一化。
- `brief.config.yaml`：新增/替换源并只挂入技术早晚报栏目。
- `.github/workflows/daily-brief.yml`：透传可选 `V2EX_TOKEN` secret。

## 7. 验证结果

### 自动验证

- 配置校验通过：4 schedules、85 sources、8 sections、3 recipients。
- TypeScript `tsc --noEmit` 通过。
- 全量 31 个测试文件、775 个测试全部通过；其中 sources、config、rank、pipeline 的重点回归
  共 153 个。
- 新增测试覆盖：HTML profile、GitHub Trending、主备切换、增量基线、时区星期判断、
  HTTP 重试和 sourceScore 归一化。

### 真实网络 dry-run

2026-09-17 使用 `morning --dry-run --no-llm` 完成两次真实抓取，耗时约 8–10 秒，均生成 17 条：

- GitHub Trending + Search 正常，`gh-trending` 入选；
- HN Firebase 正常，`hn-front` 入选并带 points/comments；
- Anthropic 官方/Release 流正常，Claude Code Release 入选；
- OpenAI 官方 RSS 正常；
- Google Developers 官方 Feed 正常；
- V2EX 在未提供 token 时成功走公开 v1 fallback 并入选；
- 没有新增源抓取失败告警；
- `--dry-run` 没有写归档或 source-state。

## 8. 运维注意事项

- `V2EX_TOKEN` 是可选 secret；不配置不影响出报，只会使用公开 v1 接口。
- `archive/source-state.json` 应与日报归档一同提交；现有 workflow 已执行 `git add archive/`，
  无需增加提交路径。
- HTML profile 若因页面结构变化返回 0 条，会触发 fallback 或告警；应修 parser，不要通过放宽
  stale 阈值掩盖。
- 新增源没有扩大栏目 limit。建议积累 7–14 天归档后再依据入选率决定是否将 tech 从 6 调到 7。
