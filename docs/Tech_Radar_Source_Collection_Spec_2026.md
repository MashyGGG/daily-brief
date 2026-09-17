# 2026 全栈 + AI 开发者技术资讯抓取规范

版本：1.0 | 基准日期：2026-09-17 | 时区：Asia/Singapore

## 1. 目标

建立由 GitHub Actions 定时执行的技术资讯聚合管线，覆盖全球技术趋势、开源项目、AI 官方更新、架构/后端/Cloud、前端生态与中文开发者社区。优先使用官方 API / RSS / Atom，其次 HTML 增量抓取；Headless Browser 仅作为最后手段。

## 2. 抓取优先原则

`官方 API > RSS/Atom > GitHub API > 静态 HTML > Headless Browser`

## 3. 信息源清单与基础权重

| 信息源                                                | 类别                           | 基础权重 | 优先级 | 频率         | 推荐抓取方式                                           | 稳定性 |
| ----------------------------------------------------- | ------------------------------ | -------: | ------ | ------------ | ------------------------------------------------------ | ------ |
| OpenAI News / Developer Docs                          | AI 官方                        |      100 | P0     | 每日         | HTML 轻量解析 + 官方 API/文档页面 Diff                 | 高     |
| Claude Platform Release Notes / Claude Code CHANGELOG | AI 官方                        |      100 | P0     | 每日         | Release Notes HTML + GitHub CHANGELOG/Release          | 很高   |
| Hacker News                                           | 全球技术趋势                   |       96 | P0     | 每日         | 官方 Firebase API                                      | 很高   |
| GitHub Trending + GitHub Search API                   | 开源趋势                       |       96 | P0     | 每日         | Trending HTML + REST Search API 自建趋势榜             | 高     |
| TLDR AI                                               | AI 聚合                        |       88 | P0     | 每日         | 公开 Archive HTML                                      | 高     |
| TLDR Tech                                             | 综合技术聚合                   |       84 | P0     | 每日         | 公开 Archive HTML                                      | 高     |
| InfoQ                                                 | 架构/后端/Cloud/AI Engineering |       86 | P0     | 每日或工作日 | RSS（优先）/主题页                                     | 很高   |
| Google Developers Blog                                | 平台/AI/开发者工具官方         |       90 | P1     | 每日         | Feed（如可用）或 HTML 增量解析                         | 高     |
| Hugging Face Blog                                     | 开源 AI / 模型 / 推理          |       90 | P1     | 每日或隔日   | RSS feed.xml + Blog HTML                               | 中高   |
| Lobsters                                              | 深度工程社区                   |       78 | P1     | 每日         | RSS                                                    | 很高   |
| Stack Overflow Blog                                   | 开发者生态/工程实践            |       76 | P1     | 每日或每周   | RSS/HTML                                               | 高     |
| JavaScript Weekly                                     | 前端/JS/TS                     |       76 | P1     | 每周         | Archive/Newsletter HTML；如检测到可用 Feed 则优先 Feed | 中高   |
| Changelog                                             | OSS/DevTools/Infrastructure    |       78 | P1     | 每日或每周   | RSS/站点 feed/HTML                                     | 高     |
| V2EX                                                  | 中文开发者社区                 |       72 | P1     | 每日         | 官方 API 2.0                                           | 高     |
| 阮一峰科技爱好者周刊                                  | 中文技术精选                   |       82 | P1     | 每周五       | 官方 Atom Feed                                         | 很高   |

## 4. 详细抓取规范

### 1. OpenAI News / Developer Docs

- **类别**：AI 官方
- **基础权重**：100/100
- **优先级**：P0
- **抓取频率**：每日
- **推荐方式**：HTML 轻量解析 + 官方 API/文档页面 Diff
- **认证**：新闻页无需；API 模型列表需 API Key
- **入口**：https://openai.com/news/ ; https://developers.openai.com/api/docs/models
- **实现备注**：官方一手来源。只抓新增/变更项，不建议每天全量总结。模型列表可做每日 diff。

### 2. Claude Platform Release Notes / Claude Code CHANGELOG

- **类别**：AI 官方
- **基础权重**：100/100
- **优先级**：P0
- **抓取频率**：每日
- **推荐方式**：Release Notes HTML + GitHub CHANGELOG/Release
- **认证**：公开页面通常无需；GitHub API 使用 GITHUB_TOKEN
- **入口**：https://platform.claude.com/docs/en/release-notes/overview
- **实现备注**：Claude API、SDK、Console 与 Claude Code 的一手更新来源。优先按发布日期增量抓取。

### 3. Hacker News

- **类别**：全球技术趋势
- **基础权重**：96/100
- **优先级**：P0
- **抓取频率**：每日
- **推荐方式**：官方 Firebase API
- **认证**：无需
- **入口**：https://hacker-news.firebaseio.com/v0/topstories.json
- **实现备注**：官方 API 可取 top/new/best 等故事；适合结合 score、comments 和时间衰减排序。

### 4. GitHub Trending + GitHub Search API

- **类别**：开源趋势
- **基础权重**：96/100
- **优先级**：P0
- **抓取频率**：每日
- **推荐方式**：Trending HTML + REST Search API 自建趋势榜
- **认证**：HTML 无需；REST 建议 GITHUB_TOKEN
- **入口**：https://github.com/trending ; https://api.github.com/search/repositories
- **实现备注**：Trending 无官方专用 API。生产实现建议同时抓 Trending HTML，并用 Search API 生成“最近创建且 Star 快速增长”的自定义趋势榜。

### 5. TLDR AI

- **类别**：AI 聚合
- **基础权重**：88/100
- **优先级**：P0
- **抓取频率**：每日
- **推荐方式**：公开 Archive HTML
- **认证**：无需
- **入口**：https://tldr.tech/ai/archives
- **实现备注**：适合作为 AI 领域二次筛选源；不是一手来源，因此同题材遇到官方公告时应降权/去重。

### 6. TLDR Tech

- **类别**：综合技术聚合
- **基础权重**：84/100
- **优先级**：P0
- **抓取频率**：每日
- **推荐方式**：公开 Archive HTML
- **认证**：无需
- **入口**：https://tldr.tech/tech/archives
- **实现备注**：适合快速发现热点。建议保存其摘要但最终链接优先指向原始来源。

### 7. InfoQ

- **类别**：架构/后端/Cloud/AI Engineering
- **基础权重**：86/100
- **优先级**：P0
- **抓取频率**：每日或工作日
- **推荐方式**：RSS（优先）/主题页
- **认证**：无需
- **入口**：https://www.infoq.com/
- **实现备注**：适合架构、平台工程、云、AI 工程化。RSS/主题 feed 优先于网页抓取。

### 8. Google Developers Blog

- **类别**：平台/AI/开发者工具官方
- **基础权重**：90/100
- **优先级**：P1
- **抓取频率**：每日
- **推荐方式**：Feed（如可用）或 HTML 增量解析
- **认证**：无需
- **入口**：https://developers.googleblog.com/
- **实现备注**：Google 开发者生态一手来源。实现时检测页面 feed link；若无稳定 feed 则抓文章列表并做 URL/date diff。

### 9. Hugging Face Blog

- **类别**：开源 AI / 模型 / 推理
- **基础权重**：90/100
- **优先级**：P1
- **抓取频率**：每日或隔日
- **推荐方式**：RSS feed.xml + Blog HTML
- **认证**：无需
- **入口**：https://huggingface.co/blog ; https://huggingface.co/blog/feed.xml
- **实现备注**：适合开源模型、推理、量化、WebGPU、Agent 等。RSS 历史上有兼容性问题，建议保留 HTML fallback。

### 10. Lobsters

- **类别**：深度工程社区
- **基础权重**：78/100
- **优先级**：P1
- **抓取频率**：每日
- **推荐方式**：RSS
- **认证**：公开 feed 无需
- **入口**：https://lobste.rs/
- **实现备注**：站点提供站点级、标签级 RSS。适合编译器、数据库、PL、OS、安全等深度工程主题。

### 11. Stack Overflow Blog

- **类别**：开发者生态/工程实践
- **基础权重**：76/100
- **优先级**：P1
- **抓取频率**：每日或每周
- **推荐方式**：RSS/HTML
- **认证**：无需
- **入口**：https://stackoverflow.blog/
- **实现备注**：适合开发者工作流、工程实践和生态趋势。不是实时新闻主源，权重略低。

### 12. JavaScript Weekly

- **类别**：前端/JS/TS
- **基础权重**：76/100
- **优先级**：P1
- **抓取频率**：每周
- **推荐方式**：Archive/Newsletter HTML；如检测到可用 Feed 则优先 Feed
- **认证**：无需
- **入口**：https://javascriptweekly.com/
- **实现备注**：针对 JS/TS/Node/Web 的周度精选。只在发布日抓取即可。

### 13. Changelog

- **类别**：OSS/DevTools/Infrastructure
- **基础权重**：78/100
- **优先级**：P1
- **抓取频率**：每日或每周
- **推荐方式**：RSS/站点 feed/HTML
- **认证**：无需
- **入口**：https://changelog.com/
- **实现备注**：开源、基础设施、DevTools 与工程文化。建议抓文章/播客标题、摘要和链接。

### 14. V2EX

- **类别**：中文开发者社区
- **基础权重**：72/100
- **优先级**：P1
- **抓取频率**：每日
- **推荐方式**：官方 API 2.0
- **认证**：部分接口需要 Personal Access Token
- **入口**：https://www.v2ex.com/api/v2/ ; https://www.v2ex.com/help/api
- **实现备注**：适合观察国内开发者真实讨论。优先 programmer/go/python/javascript 等节点；社区内容可信度需单独降低。

### 15. 阮一峰科技爱好者周刊

- **类别**：中文技术精选
- **基础权重**：82/100
- **优先级**：P1
- **抓取频率**：每周五
- **推荐方式**：官方 Atom Feed
- **认证**：无需
- **入口**：https://www.ruanyifeng.com/blog/atom.xml
- **实现备注**：适合作为中文精选和遗漏补充。固定周度抓取，不要每天轮询。

## 5. 文章评分模型

建议最终分数采用 0-100：

```text
final_score = source_score*0.35 + relevance*0.25 + freshness*0.15 + popularity*0.10 + authority*0.10 + novelty*0.05 - penalties
```

- `source_score`：上述信息源基础权重。
- `relevance`：与个人技术栈/关注词的匹配度（0-100）。
- `freshness`：时效性。24h 内 100；48h 85；72h 65；7 天 35；更旧原则上不进入日报。
- `popularity`：HN score/comments、GitHub stars 增长、社区讨论热度等归一化。
- `authority`：官方公告 100；项目维护者/原作者 90；专业媒体 75；聚合站 60；普通社区帖 45。
- `novelty`：是否首次出现/是否有实质新增。
- `penalties`：重复、标题党、广告、无原始来源、旧闻翻炒等惩罚。

### 推荐惩罚项

- 同一事件重复报道：-15 ~ -35（保留权威最高的一条）。
- 聚合站内容存在可识别原始官方来源：聚合条目 -10，并将原始来源设为 canonical。
- 发布时间超过 7 天且非深度文章：-25。
- 无明确来源/营销软文：-20 ~ -50。
- 仅版本小修复、且与技术栈无关：-10。

## 6. 个性化相关性关键词建议

建议初始关键词分组：`AI/Agent/LLM/MCP/RAG/Context Engineering/Coding Agent/OpenAI/Claude/Gemini/Hugging Face`、`Java/Spring/Node.js/TypeScript/JavaScript/React/Vue/Go/Rust`、`PostgreSQL/Redis/Database`、`Docker/Kubernetes/Cloud/DevOps/Observability/Security`。

## 7. 日报选取策略

1. 各源增量抓取，优先只处理最近 48 小时新增内容。
2. canonical URL 归一化并去掉 utm 等追踪参数。
3. 标题 + canonical URL + embedding/LLM 语义三层去重。
4. 规则层先从约 200-300 条压缩到 40-60 条。
5. LLM 只对候选集做相关性/新颖性判断，输出 15-25 条。
6. 日报最终推荐 10-15 条：AI 官方 2-4、开源趋势 2-3、软件工程/架构 2-3、前端/后端生态 1-2、中文社区/周刊 1-2。

## 8. GitHub Actions 调度

新加坡工作日 08:00 = UTC 00:00。建议主任务 `0 0 * * 1-5`；周刊类单独 schedule。所有任务保留 `workflow_dispatch` 手动触发。

## 9. 推荐 YAML 配置示例

```yaml
timezone: Asia/Singapore
max_age_hours: 72
daily_limit: 15
llm_candidate_limit: 50
sources:
  openai_news___developer_docs:
    enabled: true
    weight: 100
    priority: P0
    frequency: '每日'
    method: 'HTML 轻量解析 + 官方 API/文档页面 Diff'
  claude_platform_release_notes___clau:
    enabled: true
    weight: 100
    priority: P0
    frequency: '每日'
    method: 'Release Notes HTML + GitHub CHANGELOG/Release'
  hacker_news:
    enabled: true
    weight: 96
    priority: P0
    frequency: '每日'
    method: '官方 Firebase API'
  github_trending_plus_github_search_a:
    enabled: true
    weight: 96
    priority: P0
    frequency: '每日'
    method: 'Trending HTML + REST Search API 自建趋势榜'
  tldr_ai:
    enabled: true
    weight: 88
    priority: P0
    frequency: '每日'
    method: '公开 Archive HTML'
  tldr_tech:
    enabled: true
    weight: 84
    priority: P0
    frequency: '每日'
    method: '公开 Archive HTML'
  infoq:
    enabled: true
    weight: 86
    priority: P0
    frequency: '每日或工作日'
    method: 'RSS（优先）/主题页'
  google_developers_blog:
    enabled: true
    weight: 90
    priority: P1
    frequency: '每日'
    method: 'Feed（如可用）或 HTML 增量解析'
  hugging_face_blog:
    enabled: true
    weight: 90
    priority: P1
    frequency: '每日或隔日'
    method: 'RSS feed.xml + Blog HTML'
  lobsters:
    enabled: true
    weight: 78
    priority: P1
    frequency: '每日'
    method: 'RSS'
  stack_overflow_blog:
    enabled: true
    weight: 76
    priority: P1
    frequency: '每日或每周'
    method: 'RSS/HTML'
  javascript_weekly:
    enabled: true
    weight: 76
    priority: P1
    frequency: '每周'
    method: 'Archive/Newsletter HTML；如检测到可用 Feed 则优先 Feed'
  changelog:
    enabled: true
    weight: 78
    priority: P1
    frequency: '每日或每周'
    method: 'RSS/站点 feed/HTML'
  v2ex:
    enabled: true
    weight: 72
    priority: P1
    frequency: '每日'
    method: '官方 API 2.0'
  阮一峰科技爱好者周刊:
    enabled: true
    weight: 82
    priority: P1
    frequency: '每周五'
    method: '官方 Atom Feed'
```

## 10. 推荐目录结构

```text
tech-radar/
├── .github/workflows/daily.yml
├── collectors/
├── processors/
│   ├── normalize.py
│   ├── deduplicate.py
│   ├── rank.py
│   └── summarize.py
├── config/sources.yaml
├── config/keywords.yaml
├── data/state/
├── output/daily/
└── main.py
```

## 11. 数据结构建议

```json
{
  "id": "sha256(canonical_url)",
  "source": "hacker_news",
  "title": "...",
  "url": "...",
  "canonical_url": "...",
  "published_at": "2026-09-17T00:00:00Z",
  "fetched_at": "...",
  "summary_raw": "...",
  "tags": ["ai", "agent"],
  "metrics": { "score": 123, "comments": 45, "stars": null },
  "source_weight": 96,
  "final_score": 88.4
}
```

## 12. 首版接入顺序

**P0 首版**：OpenAI、Claude、Hacker News、GitHub、TLDR AI、TLDR Tech、InfoQ。

**P1 第二阶段**：Google Developers Blog、Hugging Face、Lobsters、Stack Overflow Blog、JavaScript Weekly、Changelog、V2EX、阮一峰周刊。

## 13. 工程规则

- 默认网络超时 15-30 秒，重试 2 次，指数退避。
- 每源独立 collector，单源失败不得使日报整体失败。
- 保存 last_seen_id / last_seen_url / ETag / Last-Modified（若支持）。
- HTTP 遵守 robots.txt、站点条款与合理频率；不要高频抓取。
- 所有密钥进入 GitHub Actions Secrets，禁止提交仓库。
- 解析器必须有 fallback；HTML selector 变化时记录告警而非静默空结果。
- 日报必须保留原文 URL，不用 AI 摘要替代来源。

## 14. 已核验依据（2026-09-17）

- Hacker News 官方 API：提供 topstories/newstories/beststories/item 等 Firebase JSON endpoint，文档注明当前无 rate limit。
- GitHub：REST API 提供 repository search；Trending 页面存在，但没有专用官方 Trending REST endpoint，因此推荐 HTML + Search API 组合。
- Anthropic：Claude Platform Release Notes 明确覆盖 API/SDK/Console，并指向 Claude Code 仓库 CHANGELOG。
- V2EX：官方 API 2.0 Beta 提供 nodes/:node_name/topics 等接口，并支持 Personal Access Token。
- InfoQ：主题页面提供 RSS Feed。
- TLDR：Tech 与 AI 均提供公开 Archives。
- Hugging Face：Blog 提供 feed.xml，但应保留 HTML fallback。
- Lobsters：官方 About 说明提供站点级与标签级 RSS。
