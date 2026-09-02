# 源清单（Sources）

这份文档回答一个问题：**早报里的内容到底从哪来。**

数据的唯一真相是 [`brief.config.yaml`](../brief.config.yaml) 的 `sources` / `sections` 两段，
本文是它的可读版本 —— 逐源列出抓取端点、权重、栏目归属和「为什么是这个值」，
外加一份**没有接入的源**及其原因，免得下次重新踩一遍坑。

- 快照时间：**2026-09-02**（端点与源数）；栏内实测数据仍是 2026-08-20 / 08-24 那两次快照
- 最近一次健康复核：**2026-09-02**，口径是归档里 45 期真实运行的告警统计，见 §9.4
- 规模：**78 个源 / 3 种适配器 / 8 个栏目**，分两组跑：
  - 技术早晚报（`morning` / `evening`）四栏，每期最多 **17 条**
  - 要闻期（`news-am` / `news-pm`）三栏，每期最多 **30 条**，编排理由见
    [`docs/NEWS-EDITION.md`](./NEWS-EDITION.md)
- 所有 feed 都实测过：可达、非空、UTF-8，且**逐个量过「最新条目距今多久」**（§9）——
  技术栏测于 2026-08-20，三个新闻栏测于 2026-08-24
- 改源之后请回来同步这份文档，它不是自动生成的

---

## 0. 一张表看懂全局

| 栏目 id    | 标题      | 源数 | 每日 limit | 过滤规则                                                |
| ---------- | --------- | ---: | ---------: | ------------------------------------------------------- |
| `tech`     | 国际技术  |   17 |          6 | 排除 crypto / NFT / web3 / memecoin                     |
| `ai`       | AI 工程   |    7 |          4 | 无（`anthropic` 试运行期间从 3 提到 4）                 |
| `cn-tech`  | 中文技术  |    9 |          5 | 无（`36kr-ai` 试运行期间从 4 提到 5）                   |
| `security` | 安全公告  |    3 |          2 | 排除 ICS / 工控 / PLC / SCADA / Siemens / …             |
| `releases` | 依赖发版  |    8 |          3 | 排除 canary / nightly / -rc / -alpha / -beta / SNAPSHOT |
| `news`     | 国际要闻  |   14 |         12 | 无                                                      |
| `cn-news`  | 国内要闻  |   11 |         10 | 无                                                      |
| `cn-life`  | 民生·社会 |    9 |          8 | 无                                                      |

上面前五栏（`tech` … `releases`）属于**技术早晚报**，后三栏属于**要闻期** ——
两组由 `schedules[].sections` 的白名单分开跑，互不抢席位。哪一期跑哪几栏是配置，
不是代码：见 [`docs/NEWS-EDITION.md` §1](./NEWS-EDITION.md)。

按适配器分：`rss` 76 个、`hackernews` 1 个、`github` 1 个。
每个源都恰好属于一个栏目，没有孤儿源，也没有被两个栏目共用的源。

各栏 `limit` 相加：技术早晚报 **17**、要闻期 **30**（`releases` 已关，它的 3 席不计），
这就是每期的条数上限。加源的时候记得回头改 `brief.config.yaml` 里 `sections:` 上方
那段注释里的数字 —— 它已经过期过一次。

---

## 1. 怎么读下面的表

三个字段决定「今天谁能上榜」，缺一不可：

**`weight`（源权重）** —— 读作「当这个源发文时，我有多想在早报里看到它」。
RSS 条目本身不带热度分，`rank.ts` 给所有 RSS 一律 0.5 中位数，所以**栏目内的排序只由
`weight × 新鲜度` 决定**。低频但高相关的源（`ruanyifeng` 周更、`react-blog`）反而给高权重，
否则它们永远抢不过日更源。

完整公式（[`src/core/rank.ts`](../src/core/rank.ts)）：

```
rankScore = weight × (0.6 × normScore + 0.4 × recency)
  normScore = 该条在**本源内**的分数百分位（HN points / GitHub stars）；无分数的源固定 0.5
  recency   = 1 − (now − publishedAt) / lookbackHours，钳制到 [0,1]
```

**`limit`（栏目上限）** —— 因为 `minPerSource: 1`，每个源先各分一个席位，直到 `limit` 满。
所以 `limit` 的真实含义是「**今天最多出现几个不同的源**」。
栏目里的源比 `limit` 多时会轮换：谁今天发的东西最强谁上。这正是 Hacker News 吃不掉整个栏目的原因。
想让早报变短就调 `limit`，**不要删源** —— 源多是好事。

**`params.limit`（单源截断）** —— 只出现在少数源上，用来给巨型 feed 封顶（`openai` 全量 1000+ 条）。
默认值：`rss` 50、`hackernews` 50、`github` 30。

第四个字段 **`staleAfterDays`（停更预警线）** 不参与排序，只管健康检查：见 §9。

抓取层的行为（[`src/sources/index.ts`](../src/sources/index.ts)）：所有源**并发抓取、失败隔离** ——
单个源挂掉只在早报里留一条抓取告警，不影响其它源出报。单请求超时 20s，响应体上限 8 MB。

---

## 2. `tech` 国际技术（17 源 / limit 6）

排除关键词：`crypto`、`NFT`、`web3`、`memecoin`。

### 讨论热度

| 源               | 类型         | 端点 / 参数                                                        |   w | 备注                                                             |
| ---------------- | ------------ | ------------------------------------------------------------------ | --: | ---------------------------------------------------------------- |
| `hn-front`       | `hackernews` | HN Algolia `/search?tags=front_page`，`minPoints:100`，`limit:60`  | 1.3 | 免费免鉴权；带真实 points，是少数几个有热度分的源                |
| `gh-trending-ts` | `github`     | `/search/repositories`，`language:typescript`，7 天内，`stars>=50` | 1.0 | GitHub 没有官方 Trending API，**绝不爬 HTML 页**，用搜索等价替代 |
| `lobsters`       | `rss`        | `https://lobste.rs/rss`                                            | 0.9 | HN 的小众替代，重合度低                                          |

### 架构与工程

| 源                   | 端点                                            |   w | 备注             |
| -------------------- | ----------------------------------------------- | --: | ---------------- |
| `bytebytego`         | `https://blog.bytebytego.com/feed`              | 1.1 | 系统设计，日更   |
| `infoq-arch`         | `https://feed.infoq.com/architecture-design/`   | 1.0 |                  |
| `martinfowler`       | `https://martinfowler.com/feed.atom`            | 1.2 | 低频，权重补偿   |
| `pragmatic-engineer` | `https://newsletter.pragmaticengineer.com/feed` | 1.1 | 部分文章有付费墙 |

### 前端本行

低频高相关，靠 `weight` 保住席位。

| 源           | 端点                                                |   w | 2026-09-02 最新条目 |
| ------------ | --------------------------------------------------- | --: | ------------------: |
| `react-blog` | `https://react.dev/rss.xml`                         | 1.2 |               190 d |
| `web-dev`    | `https://web.dev/static/blog/feed.xml`              | 1.1 |                96 d |
| `chrome-dev` | `https://developer.chrome.com/static/blog/feed.xml` | 1.2 |                72 d |
| `ts-devblog` | `https://devblogs.microsoft.com/typescript/feed/`   | 1.1 |                55 d |
| `css-tricks` | `https://css-tricks.com/feed/`                      | 0.9 |                36 h |

**这四个源在 25 期里 0 上榜，但它们没有坏** —— 抓取每期都 200。挤掉它们的不是日更源，
是 `lookbackHours: 24`：一篇 55 天前的文章根本进不了时间窗，谈不上参与排序。所以
「拆成独立 section（`limit: 2`）」这个老结论是错的，独立栏目也救不了它们；真要让它们
稳定露面，需要的是**按栏目覆写 lookback**（现在没有这个能力），不是加席位。
在那之前它们的正确读法是「一年响几次的高相关源」，留着不占成本 —— 每期多一次 HTTP 请求而已。

`smashing` 已删（2026-09-02）：25 期里 5 期抓取失败（20%）且 0 上榜，同一个 beat 有
`css-tricks` 顶着。理由见 §7。

### 运维 / 云 / 平台

| 源                 | 端点                                  |   w | 备注                                                    |
| ------------------ | ------------------------------------- | --: | ------------------------------------------------------- |
| `github-changelog` | `https://github.blog/changelog/feed/` | 1.0 |                                                         |
| `cloudflare`       | `https://blog.cloudflare.com/rss/`    | 0.9 |                                                         |
| `kubernetes`       | `https://kubernetes.io/feed.xml`      | 1.0 | 全库最大的 feed，约 1.2 MB、约 44k 个 XML 实体（见 §6） |

### 科技媒体（行业侧，不是硬技术）

| 源             | 端点                                              |   w |
| -------------- | ------------------------------------------------- | --: |
| `verge`        | `https://www.theverge.com/rss/index.xml`          | 0.7 |
| `ars-technica` | `https://feeds.arstechnica.com/arstechnica/index` | 0.7 |

---

## 3. `ai` AI 工程（7 源 / limit 4）

| 源              | 端点                                                 |   w | 备注                         |
| --------------- | ---------------------------------------------------- | --: | ---------------------------- |
| `simonwillison` | `https://simonwillison.net/atom/everything/`         | 1.2 | LLM 工程实践，本栏信噪比最高 |
| `openai`        | `https://openai.com/news/rss.xml`（`limit:30`）      | 1.1 | 全量 1000+ 条，**必须限量**  |
| `google-ai`     | `https://blog.google/technology/ai/rss/`             | 1.0 |                              |
| `deepmind`      | `https://deepmind.google/blog/rss.xml`（`limit:30`） | 0.9 |                              |
| `huggingface`   | `https://huggingface.co/blog/feed.xml`（`limit:30`） | 0.9 |                              |
| `latent-space`  | `https://www.latent.space/feed`                      | 1.1 | 工程向 newsletter + 播客     |
| `anthropic`     | `https://rsshub.bestblogs.dev/anthropic/news`        | 1.1 | **第三方镜像**，试运行中     |

**Anthropic 官方仍然没有 RSS**（`/rss.xml` 与 `/news/rss.xml` 都是 404）。早先用 Google News
站内检索兜底，实测只回一条标题为「- Anthropic」的空壳条目，占席位不产内容，已放弃。
现在改走第三方 RSSHub 镜像试运行（2026-08-20 实测：200、10 条、最新 8.6 天前）。
代价与 `36kr-ai` 同类 —— 别人的服务器，随时可能关停，挂了只留一条抓取告警。

试运行期间本栏 `limit` 从 3 提到 4：5 → 7 个源却不加席位，等于让新源永远挤不进来。
不留就删掉 `anthropic` 并把 `limit` 调回 3。

---

## 4. `cn-tech` 中文技术（9 源 / limit 5）

| 源             | 端点                                                   |   w | 备注                                                   |
| -------------- | ------------------------------------------------------ | --: | ------------------------------------------------------ |
| `solidot`      | `https://www.solidot.org/index.rss`                    | 1.1 |                                                        |
| `oschina`      | `https://www.oschina.net/news/rss`                     | 0.9 |                                                        |
| `infoq-cn`     | `https://www.infoq.cn/feed`                            | 1.0 |                                                        |
| `ruanyifeng`   | `http://www.ruanyifeng.com/blog/atom.xml`              | 1.3 | 周更，所以权重给满；注意是 **http**                    |
| `meituan-tech` | `https://tech.meituan.com/feed/`                       | 1.2 |                                                        |
| `zhangxinxu`   | `https://www.zhangxinxu.com/wordpress/feed/`           | 1.2 | 前端 CSS                                               |
| `juejin`       | Google News `site:juejin.cn`（`when:24h`，`limit:40`） | 0.7 | 官方 RSS 在 runner 上被挡，2026-09-02 改道（见下）     |
| `36kr-ai`      | `https://rsshub.bestblogs.dev/36kr/motif/327686782977` | 0.9 | **第三方 RSSHub 镜像**，2026-09-02 换实例（见下 + §7） |
| `sspai`        | `https://sspai.com/feed`                               | 0.8 |                                                        |

两个必须知道的坑，细节见 [`docs/CN-SOURCES.md`](./CN-SOURCES.md)：

- **掘金官方 RSS 在 runner 上不可用（2026-09-02 改道）。** `https://juejin.cn/rss` 从本机抓
  一切正常（20 条、日期齐全、最新 0 小时），但在 GitHub Actions 上 25 期里 **15 期返回
  200 + 0 条**（60%）—— 是掘金按 IP 段给海外机房发空壳，不是 feed 变形。现改走 Google News
  站内检索：同一个 runner 上所有 `gn-*` 源 19/19 全勤，这条路径本身已经被证明可达；
  实测标题就是掘金原文（「Android 17 + OkHttp 5.5.0…」「现在网页都能提供 MCP 了？！」）。
  历史结论仍然成立、只是不再用得上：官方 feed 的 `?cate=frontend` 之类分类参数是假的
  （frontend vs backend 重合 100%），窗口也只有约 4 小时。
- **36氪 官方 feed 已死**（`/feed` 现在返回 SPA 的 HTML 壳）。走第三方 RSSHub 镜像的
  「人工智能·AI」专题路由，而不是 `/newsflashes`（那是财经通稿，且 20 条只覆盖 1.5 小时）。
  **2026-09-02 换实例**：原来的 `rss.injahow.cn` 在 25 期里挂了 5 期（20%，主要是 20s
  `AbortError` 超时），本机连测 4 次也有 1 次直接连不上；改指 `rsshub.bestblogs.dev` ——
  本仓 `anthropic` 已经在用它、同期 25 期 0 失败，实测同一路由返回 20 条同样的专题内容。
  风险模型没变，只是换了一台**被本仓验证过**的别人的服务器。
  试运行不留就把 `cn-tech` 的 `limit` 调回 4 并删掉这个源。

---

## 5. 其余五栏

### `security` 安全公告（3 源 / limit 2）

唯一一类「不看会出事」的信息。

| 源                | 端点                                                                  |   w | 备注                            |
| ----------------- | --------------------------------------------------------------------- | --: | ------------------------------- |
| `cisa-advisories` | `https://www.cisa.gov/cybersecurity-advisories/all.xml`（`limit:40`） | 1.0 | 以工控/ICS 为主，靠排除词过滤   |
| `hacker-news-sec` | `https://feeds.feedburner.com/TheHackersNews`                         | 1.0 | The Hacker News，**与 HN 无关** |
| `krebs`           | `https://krebsonsecurity.com/feed/`                                   | 1.1 |                                 |

排除词：`ICS Advisory`、`ICS Medical`、`Industrial Control`、`PLC`、`SCADA`、`Siemens`、`Rockwell`。
只排「ICS Advisory」不够 —— 实测漏掉了「…Threat to Siemens S7 Series PLCs」这类标题。

### `releases` 依赖发版（8 源 / limit 3）

升级窗口与 breaking change 预警。GitHub 的 `releases.atom` 是标准 Atom，现有 rss adapter 直接吃，零代码。
条目标题是裸版本号（`v8.2.2`），靠渲染层带出的源名分辨是哪个仓库。

| 源                     | 端点                                                           |   w | 备注       |
| ---------------------- | -------------------------------------------------------------- | --: | ---------- |
| `nextjs-releases`      | `https://github.com/vercel/next.js/releases.atom`              | 1.2 |            |
| `react-releases`       | `https://github.com/facebook/react/releases.atom`              | 1.1 |            |
| `typescript-releases`  | `https://github.com/microsoft/TypeScript/releases.atom`        | 1.1 |            |
| `node-releases`        | `https://github.com/nodejs/node/releases.atom`                 | 1.1 |            |
| `spring-boot-releases` | `https://github.com/spring-projects/spring-boot/releases.atom` | 1.0 |            |
| `pnpm-releases`        | `https://github.com/pnpm/pnpm/releases.atom`                   | 1.1 | 本仓库在用 |
| `vitest-releases`      | `https://github.com/vitest-dev/vitest/releases.atom`           | 1.1 | 本仓库在用 |
| `eslint-releases`      | `https://github.com/eslint/eslint/releases.atom`               | 1.0 | 本仓库在用 |

后三个是工具链，breaking change 的概率比框架本身还高。加了 3 个源，`limit` 跟着 2 → 3 ——
发版消息的价值高度依赖时效，宁可多给一个席位。**Vite 没接**：本仓库不用它，日常也是
Next.js 自带的构建链，接了只会稀释这一栏。

排除词：`canary`、`nightly`、`-rc`、`-alpha`、`-beta`、`SNAPSHOT` —— 预发布版一天能出好几个
（next.js 的 canary 尤其密），会把真正该看的稳定版挤掉。

### `news` 国际要闻（14 源 / limit 12）

要闻期（`news-am` / `news-pm`）的三栏之一。全部 2026-08-24 实测：可达、非空、UTF-8、
最新条目龄期 ≤ 2.6 天。`n` = 实测条数。

| 源               | 端点                                                                  |   w |   n | 备注                              |
| ---------------- | --------------------------------------------------------------------- | --: | --: | --------------------------------- |
| `bbc-zhongwen`   | `https://feeds.bbci.co.uk/zhongwen/simp/rss.xml`                      | 1.2 |   — | 从 `cn-news` 移入 —— 它写的是国际 |
| `nyt-cn`         | `https://cn.nytimes.com/rss.html`                                     | 1.1 |  20 | 纽约时报中文网                    |
| `rfi-zh`         | `https://www.rfi.fr/cn/rss`                                           | 1.0 |  30 | 法广中文                          |
| `un-news-zh`     | `https://news.un.org/feed/subscribe/zh/news/all/rss.xml`              | 0.9 |  30 | 机构口径                          |
| `bbc-world`      | `https://feeds.bbci.co.uk/news/world/rss.xml`                         | 0.9 |   — |                                   |
| `guardian-world` | `https://www.theguardian.com/world/rss`                               | 0.8 |   — | 三条 `stripPatterns` 去订阅推广   |
| `nyt-world`      | `https://rss.nytimes.com/services/xml/rss/nyt/World.xml`              | 0.8 |  58 | 量最大，靠 `limit` 压             |
| `aljazeera`      | `https://www.aljazeera.com/xml/rss/all.xml`                           | 0.8 |   — |                                   |
| `nyt-home`       | `https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml`           | 0.7 |  20 | 头版，含非国际条目                |
| `npr-news`       | `https://feeds.npr.org/1001/rss.xml`                                  | 0.7 |  10 | 条数克制                          |
| `ft-world`       | `https://www.ft.com/world?format=rss`                                 | 0.7 |  25 | 财经视角                          |
| `economist-week` | `https://www.economist.com/the-world-this-week/rss.xml`（`limit:50`） | 0.7 | 300 | 周刊，feed 里堆着历史条目         |
| `gn-world-zh`    | Google News 国际（中文，`limit:40`）                                  | 0.6 |  27 | 兜底，无法与直连源去重            |
| `un-news-en`     | `https://news.un.org/feed/subscribe/en/news/all/rss.xml`              | 0.6 |  30 | 低频                              |

**权重为什么中文源全在上面**：`LLM_API_KEY` 这个 secret 目前没配，`llm.sections.news`
那句中文 oneline 因此从来没跑过（扫过 `archive/2026/08/` 全部 9 期 166 条，`withSummary=0`），
英文源进邮件就是原样英文 excerpt。**配上 key 之后回来把权重调平** —— 这是整份配置里
唯一一处「将来要回滚的临时值」。

### `cn-news` 国内要闻（11 源 / limit 10）

| 源                  | 端点                                                     |   w |   n | 备注                         |
| ------------------- | -------------------------------------------------------- | --: | --: | ---------------------------- |
| `chinanews-import`  | `https://www.chinanews.com.cn/rss/importnews.xml`        | 1.2 |  30 | 主源                         |
| `chinanews-china`   | `https://www.chinanews.com.cn/rss/china.xml`             | 1.1 |  30 |                              |
| `jiemian`           | Google News `site:jiemian.com`（`when:24h`，`limit:40`） | 0.9 |   — | 界面新闻，2026-09-02 改道    |
| `thepaper`          | Google News `site:thepaper.cn`（`when:24h`，`limit:40`） | 0.9 |   — | 澎湃无官方 feed              |
| `chinanews-finance` | `https://www.chinanews.com.cn/rss/finance.xml`           | 0.9 |  30 | 站内那个 `rss/cj.xml` 是 404 |
| `cna-zh`            | `https://feeds.feedburner.com/rsscna/mainland`           | 0.8 |  20 | 中央社，第三方中转           |
| `gn-nation-zh`      | Google News 国内（中文，`limit:40`）                     | 0.8 |  43 | 兜底                         |
| `scmp-china`        | `https://www.scmp.com/rss/4/feed`                        | 0.7 |  50 | 英文写中国，视角互补         |
| `gn-business-zh`    | Google News 财经（中文，`limit:40`）                     | 0.7 |  32 | 兜底                         |
| `yahoo-hk`          | `https://hk.news.yahoo.com/rss/hong-kong`                | 0.7 |  30 | 港闻                         |
| `gnews-cn`          | Google News 中文头条（`limit:40`）                       | 0.6 |   — | 0.8 → 0.6 降权，见下         |

`jiemian` 从 1.0 降到 0.9，不是内容变差了：换成 Google News 转发之后它的条目 URL 指向
`news.google.com` 跳转链接，跟直连源对不上 id、无法自动去重 —— 本节末尾那条「Google News
类源权重一律 ≤ 0.9」的规则对它同样适用。`mingpao` 已删，理由见 §7。

`gnews-cn` 降权的原因不是它不新，而是它的 `description` 被 Google 塞进了「同题相关报道
列表」：实测 excerpt 长这样 ——「中农批宿迁市场：…东方财富 …观察者 …新浪财经」。
两个后果：邮件里是纯噪音；长度 > 80 会撞上 `llm.when.excerptShorterThan`，被判为
「源摘要已经够用」，**就算将来配了 key 也永远不会被改写**。

### `cn-life` 民生·社会（9 源 / limit 8）

一半是 Google News 检索源：民生话题没有哪个官方 feed 能覆盖，检索是唯一拿得到面的方式。
检索源全部带 `when:24h`、`limit:40`。

| 源                  | 端点                                           |   w |   n | 备注     |
| ------------------- | ---------------------------------------------- | --: | --: | -------- |
| `chinanews-society` | `https://www.chinanews.com.cn/rss/society.xml` | 1.2 |  30 | 主源     |
| `chinanews-life`    | `https://www.chinanews.com.cn/rss/life.xml`    | 1.0 |  16 | 生活服务 |
| `gn-minsheng`       | 检索：民生 / 社保 / 医保 / 就业 / 房价 / 物价  | 0.9 |  30 |          |
| `gn-disaster`       | 检索：台风 / 暴雨 / 地震 / 应急 / 预警         | 0.9 |  23 |          |
| `gn-govcn`          | 检索：`site:gov.cn`                            | 0.8 | 100 | 政策原文 |
| `gn-health-zh`      | Google News 健康（中文）                       | 0.7 |  70 |          |
| `gn-food`           | 检索：食品安全 / 药品 / 抽检 / 召回            | 0.7 |  10 |          |
| `gn-edu`            | 检索：教育 / 高考 / 义务教育 / 招生            | 0.6 |  10 |          |
| `gn-science-zh`     | Google News 科学（中文）                       | 0.5 |  18 |          |

### 三栏共同的两个坑

**① Google News 的可读路径会 302，配置里必须写重定向后的 id。**
`/rss/headlines/section/topic/WORLD` 会跳到 `/rss/topics/<base64>`；写可读路径等于把
「哪天 Google 改了跳转」变成静默失效。已解析好的五个频道 id 记在
[`docs/NEWS-EDITION.md` §2.4](./NEWS-EDITION.md)，配置里写的就是它们。

**② 标题后缀必须 strip，而且中文那条不能少。**
Google News 给每条标题缀上「 - 来源名」，来源名多半是中文（`- 新华网客户端`、`- 第一财经`、
`- 四川在线`）。原有的 `gnews-cn` 只匹配 ASCII 域名形状（`- thepaper.cn`），对中文无效。
这不是美观问题：本仓库实测过，**共享后缀能把 4-gram 相似度刷到 0.327，比真正的跨源转载
（0.286）还高**，会把 `dedupe.titleSimilarity: 0.2` 从去重器变成误杀器。
所以每个 `gn-*` 源都挂着同一份 `stripPatterns`（配置里用 YAML 锚点 `&gn-strip` 共享一份）：
ASCII 域名后缀、中文来源名后缀，外加 excerpt 末尾那句「在 Google 新闻上查看更多头条新闻和观点」。
中文那条要求后缀以中文开头、≤ 15 字、最多再跟两个拉丁词（`中國報 China Press`），
避免吃掉正常标题里的破折号尾巴 —— 2026-08-24 的 dry-run 结果逐条对过。

**Google News 类源无法与直连源自动去重**：条目 URL 指向 `news.google.com` 跳转链接，
跟直连源的 id 对不上。这是把它们权重一律压到 ≤ 0.9 的原因。

> 栏目 id 保持 `news` / `cn-news` 不变：已归档的 2026-08-20 那期用的就是这两个 id，
> 改名会让 `--from-archive` 重发时丢掉整栏。

---

## 6. 三种适配器

新增一个**源**是纯配置；新增一个**源类型**才要写代码（`src/sources/` 加一个 fetcher +
`FETCHERS` 注册一行 + `sourceSchema` 加一个分支）。

| 类型         | 实现                                                        | 抓取方式                        | 是否带热度分       |
| ------------ | ----------------------------------------------------------- | ------------------------------- | ------------------ |
| `rss`        | [`src/sources/rss.ts`](../src/sources/rss.ts)               | GET 单个 URL，`fast-xml-parser` | 否 → 固定 0.5 中位 |
| `hackernews` | [`src/sources/hackernews.ts`](../src/sources/hackernews.ts) | HN Algolia JSON API，免鉴权     | 是（points）       |
| `github`     | [`src/sources/github.ts`](../src/sources/github.ts)         | GitHub Search API               | 是（stars）        |

几点实现细节，改源时可能会撞上：

- **RSS 解析同时吃 RSS 2.0 / RDF / Atom**，`link` 优先取 `rel="alternate"`，
  日期依次尝试 `pubDate` → `published` → `updated` → `dc:date`。
- **XML 实体预算被显式放大到 500k**。`fast-xml-parser` 把 `&amp;` 这类预定义实体也算进
  billion-laughs 预算，布尔形式的上限只有 1000，而 kubernetes.io 一个 feed 就有约 44k 个 ——
  这条曾经一次打死 9 个源（commit `9e57e5d`）。放大的只有计数，真正防御恶意 DTD 的
  `maxExpansionDepth` / `maxEntitySize` / `maxExpandedLength` 仍保持严格默认值。
- **`minPoints` / `minStars` 是硬地板**，在过滤阶段生效（[`src/core/filter.ts`](../src/core/filter.ts)），
  无分数的条目会被这条地板直接剔除 —— 所以别给 RSS 源写这两个参数。
- **`GITHUB_TOKEN` 只影响限速**：Actions 会自动注入，把 search 从 10/min 提到 30/min；本地没有也能跑。

---

## 7. 没有接入的源，以及原因

删掉一个源很容易，重新论证一遍很贵。这一节就是为了别重复论证。

| 源 / 方案                | 状态         | 原因                                                                                              |
| ------------------------ | ------------ | ------------------------------------------------------------------------------------------------- |
| `gh-trending-any`        | 注释保留     | 语言无关的 trending，面更宽但噪声更大；想要就取消注释                                             |
| `aws-whatsnew`           | 注释保留     | 日更约 100 条且以服务/可用区公告为主，信噪比太低                                                  |
| Anthropic 官方博客       | 无官方源     | 没有 RSS（404）；Google News 兜底只回空壳条目。现走第三方镜像试运行，见 §3                        |
| 36氪 官方 feed           | 已死         | `/feed` 返回 SPA 的 HTML 壳，不是 XML                                                             |
| 36氪 `/newsflashes` 路由 | 评估后否决   | 财经通稿线（三大股指、ETF 成交额），且 20 条只覆盖 1.5 小时                                       |
| 微信公众号               | **建议放弃** | 官方从未开放订阅他人公众号的接口；wewe-rss 已 archived、RSSHub `/wechat/*` 503、feeddd 域名已失效 |
| 官方 `rsshub.app`        | 不可用       | 被 Cloudflare 挡住（403 "Just a moment..."）                                                      |
| 明报港闻                 | **已退役**   | runner 上 19/19 全部 HTTP 403（见下）                                                             |
| Smashing Magazine        | **已退役**   | 20% 抓取失败且 25 期 0 上榜（见下）                                                               |
| 掘金官方 RSS             | 已改道       | runner 上 60% 返回 200 + 0 条；现走 Google News 站内检索                                          |
| 界面新闻官方 RSS         | 已改道       | runner 上 37% `fetch failed`；现走 Google News 站内检索                                           |
| `rss.injahow.cn`         | 已换实例     | 20% 超时；36kr 改指 `rsshub.bestblogs.dev`                                                        |

### 2026-09-02 健康复核：退役与改道

口径是 `archive/` 里 45 期真实运行的告警统计（§9.4 是完整的表），这里只记「因此动了什么」。
**所有结论都用 runner 的行为，不是本机的**：这一轮里本机对全部 80 个源探测 80/80 全绿，
包括下面这些在 CI 上从没成功过的 —— 再次印证 §7 末尾那条「runner 在美国」的前提。

| 源         | 归档证据                            | 处置                          | 为什么是这个处置                                                                                                   |
| ---------- | ----------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `mingpao`  | 19/19 期 `HTTP 403`，一次都没成功过 | **删源**                      | Google News `site:mingpao.com` 实测回的是招聘/生活广告，不是港闻，没有可用替代；港闻已有 `yahoo-hk` + `scmp-china` |
| `smashing` | 5/25 期抓取失败 + 25 期 0 上榜      | **删源**                      | 同 beat 有 `css-tricks`；留着只是每期多一次会挂的请求                                                              |
| `juejin`   | 15/25 期 `200 + 0 条`               | 改道 Google News `site:` 检索 | `gn-*` 在同一 runner 上 19/19 全勤，是已被证明可达的路径                                                           |
| `jiemian`  | 7/19 期 `TypeError: fetch failed`   | 改道 Google News `site:` 检索 | 同上；权重同步 1.0 → 0.9（Google News 类源无法与直连源去重）                                                       |
| `36kr-ai`  | 5/25 期失败（`AbortError` 为主）    | 换 RSSHub 实例                | `rsshub.bestblogs.dev` 同期 0 失败，本仓 `anthropic` 已在用                                                        |

**没有动、且是故意的**：`react-blog` / `web-dev` / `chrome-dev` / `ts-devblog` 25 期 0 上榜，
但抓取每期都成功 —— 它们是发布节奏本来就以月/季计的源，被 24 小时时间窗挡在外面，
不是坏源（§2「前端本行」那段讲了为什么独立栏目也救不了）。`meituan-tech` 同理留下，
但它的问题不一样，见 §9.3。

### 2026-08-20 批量评估：一份「看起来很像」的推荐清单

有人给过一份补充源清单，全部实测了一遍。**近一半是死源**，记在这里省得下次再评估一次：

| 候选                  | 实测结果                            | 结论                                                     |
| --------------------- | ----------------------------------- | -------------------------------------------------------- |
| Increment（Stripe）   | 最新 2021-11-09（1745 天前）        | 停刊，不接                                               |
| High Scalability      | 推荐的 URL 404；换对也停在 832 天前 | 事实停更，不接                                           |
| 酷壳 CoolShell        | 最新 2023-05-08（1200 天前）        | 作者已故，不接                                           |
| Reuters / AP          | 404 / 401                           | 公开 RSS 已停，不接                                      |
| 财新                  | 返回 HTML 壳                        | 不是 XML，不接                                           |
| 联合早报（anyfeeder） | 200、结构完好、最新 22 天前         | **典型的静默失效**，不接（见 §9）                        |
| GitHub Advisories     | 406（带 Accept 头也一样）           | GitHub 挡了，要走 API 才行                               |
| MSRC 官方 RSS         | 200、4920 条、最新 0.7 天前         | 源是活的，但 Windows/Office 生态与本人技术栈不对口，不接 |
| The New Stack         | 200、最新 0.4 天前                  | 活跃，但 `tech` 栏已 18 源抢 6 席，不接                  |
| Josh W. Comeau        | 200、最新 44.7 天前                 | 低频，同上，不接                                         |
| Google Research       | 200、100 条、最新 2.9 天前          | 与 `google-ai` 部分重合，先不接                          |
| V2EX                  | 200、最新 0 天                      | 噪声高，`cn-tech` 已 9 源抢 5 席，不接                   |
| 界面新闻              | 200、30 条、最新 0 天               | 活跃，`cn-news` 若要换掉 `thepaper` 可用它               |

最后被采纳的只有 4 个：`latent-space`、`anthropic`（镜像试运行）、
`pnpm-releases` / `vitest-releases` / `eslint-releases`（严格说是 5 个源、3 个包）。
拒绝理由里出现最多的不是「源不好」，而是**栏目席位不够**：加源不会让早报变长，
只会稀释轮换池、让本来就低频的高价值源更难露面。

微信公众号那一项的完整论证（付费托管 vs 自建挂账号 vs 干脆不接）在
[`docs/CN-SOURCES.md` §3](./CN-SOURCES.md)。结论是：真正有技术价值的公众号内容，
绝大多数会同步到已接入的 `meituan-tech` / `infoq-cn` / `juejin` / `oschina`，投入产出比很低。

### 2026-08-24 批量评估：中文新闻源（要闻期）

建三个新闻栏时逐个探过的候选。**结论同样是近一半不能用**，其中最坑的是「200 + 结构完好

- 内容冻结在一年前」这种静默失效 —— 只看 HTTP 状态码是分辨不出来的（§9 讲的就是这件事）。

| 候选                                       | 实测结果                                               | 结论                                         |
| ------------------------------------------ | ------------------------------------------------------ | -------------------------------------------- |
| 人民网 politics / society / world          | 200、100 条、结构完好，**冻结在 2025-06-05（445 天）** | 典型静默失效，不接                           |
| 新华网 `news_politics.xml`                 | 冻结 2022-12-14，且 `pubDate` 标签残缺                 | 日期解析不出来，会被时间窗全丢               |
| 中国日报 `rss/china_rss.xml`               | 条目停在 2017，且没有 `pubDate` 字段                   | 死源                                         |
| `chinanews-scroll`（全类目滚动）           | 200、30 条、当天，**活的**                             | 与已接的 5 个 chinanews 频道重叠，白占轮换位 |
| CNN `edition_world`                        | 最新条目 1071 天前                                     | 死源                                         |
| 新浪 `focus15` / `marquee/ddt`             | 2891 天前 / 仅 1 条且无日期                            | 死源                                         |
| 网易 / 一财 / 财新 / 观察者网 / 环球网     | 返回 HTML 壳                                           | 不是 XML                                     |
| Reuters · AP · 联合早报 · 凤凰 · 央视      | 404 / 401                                              | 公开 feed 已停                               |
| 证券时报 · 新京报 · 南周 · 财联社 · 21世纪 | 404 / ECONNRESET                                       | 同上                                         |
| 参考消息 · 中青报 · hk01 · 每经            | 404 / ECONNRESET                                       | 同上                                         |
| DW 中文 / VOA 中文                         | ECONNRESET                                             | 本机网络所致，runner 上可能不同              |
| france24 中文 / 日经中文                   | 404 / 403                                              | 不接                                         |
| RSSHub 公共镜像 `rssforever`               | 503                                                    | 与本节开头那张表一致                         |

`chinanews-scroll` 那一行值得单独记一笔：它**是活的**，被否掉的理由是重叠而不是可达性。
`minPerSource: 1` 的席位分配下，一个内容与已接频道高度重合的源不会让内容变多，
只会把轮换位从别人那里拿走。

### 第三方依赖的风险，说清楚

有两个源依赖**别人的服务器**，2026-09-02 起它们指向同一台：`36kr-ai` 和 `anthropic`
都走 `rsshub.bestblogs.dev`。它随时可能关停、限流或改变行为，你的抓取行为对该实例运营者可见。
挂掉时只会留一条抓取告警，不影响出报 —— 但要知道它会挂，而且现在**一挂会挂两个源**。

选它不是因为它一定更可靠，而是因为它是本仓唯一有运行数据的那台：`anthropic` 在它上面
跑了 25 期 0 失败，而原来的 `rss.injahow.cn` 同期 20% 失败。这是可测量的差别，不是偏好。
备选路线（自写 36kr adapter ≈80 行 / 自建 RSSHub）见 `docs/CN-SOURCES.md` §2 的方案 B、C。

### 还有一个前提：runner 在美国

所有中文源的可达性探测都是从中国大陆机器发起的，**这不能证明 GitHub Actions 抓得到**。
`ubuntu-latest` 的 runner 在美国。验证一次很便宜：

```bash
gh workflow run daily-brief.yml -f dry-run=true -f sections=cn-tech
gh workflow run daily-brief.yml -f dry-run=true -f schedule=news-am   # 要闻期的 29 个新源
```

然后看输出里的「抓取告警」段落，哪个源在 runner 上抓不到一眼就能看出来。
要闻期一次引入 29 个源，这一步是**必做**而不是可选：挂掉的源只会留告警不影响出报，
但你得知道是哪几个，才能决定换掉还是留着。

---

## 8. 增删一个源

```yaml
# 1. 在 sources: 下加一条
- name: my-source # [a-z0-9-]，全局唯一
  type: rss # rss | hackernews | github
  weight: 1.0 # 「它发文时我多想看到它」
  params: { url: https://example.com/feed.xml }
# 2. 把 name 加进某个 section 的 sources: 列表 —— 不加就永远不会出现在早报里
```

- 配置由 zod 在加载时校验（[`src/config/schema.ts`](../src/config/schema.ts)）：
  重复 name、栏目引用不存在的源、非法 URL 一律**直接让整次运行失败**，不会静默跳过。
- 加源前先手动 `curl` 一下，确认返回的是 XML 而不是 HTML 壳 —— 36氪 就是这么死的。
- **顺手量一下这个源多久发一次**：比月更还慢的，必须写 `staleAfterDays`，否则健康检查
  会天天把它报成停更（§9）。
- 加完跑一次 `pnpm brief --dry-run`，看它有没有真的产出条目。
- **删源之前先想清楚**：栏目长度由 `limit` 控制，源多不会让早报变长，只会让轮换池更深。
- 改完记得同步这份文档和 `brief.config.yaml` 里的行内注释。

---

## 9. 源健康检查

### 9.1 为什么 HTTP 200 不够

`fetchAll` 已经会在源**抛错**时留告警。但真正常见的失效不长这样 —— 它长这样：
feed 返回 200、XML 结构完好、条目齐全，只是最新一条是几个月前的。
抓取层看不出任何问题，早报里那一栏就这么慢慢空了下去，而运行永远是绿的。

评估补充源时实测到两个现成的例子：**联合早报镜像** 200 + 结构完好 + 最新条目 22 天前，
**酷壳** 200 + 15 条 + 最新条目 1200 天前。只看请求成功与否，这两个都是 ✅。

所以健康判据落在**内容**而不是传输上（[`src/core/health.ts`](../src/core/health.ts)），两个信号：

| 信号                                | 含义                                       |
| ----------------------------------- | ------------------------------------------ |
| 200 但解析出 0 条                   | 正常的源不会这样，多半是 feed 变形或被换掉 |
| 最新条目超过该源的 `staleAfterDays` | 疑似停更                                   |
| 整批条目都不带日期                  | 前两个信号对它失效，见 §9.3                |

三者都只出**告警**，绝不让运行失败 —— 一个停更的源不该把整份早报带下水。

### 9.2 `staleAfterDays` 怎么取值

读作「多久没更新算**可疑**」，不是「多久没更新算失败」。默认 30 天
（`DEFAULT_STALE_AFTER_DAYS`），只有实测发布节奏本来就慢于此的源才需要写这个字段。

**别为了消掉告警随手调大它** —— 那等于把检查关掉。告警响了，先去确认源本身是不是真停更了。

下面是 2026-08-20 实测的「最新条目距今天数」，也就是这些阈值的取值依据。
只列了写了显式阈值的源，其余全部走 30 天默认值：

| 源                     | 实测 | `staleAfterDays` | 为什么放宽                                |
| ---------------------- | ---: | ---------------: | ----------------------------------------- |
| `typescript-releases`  | 125d |              240 | 全仓库最慢的源                            |
| `web-dev`              |  83d |              180 | 最接近「疑似停更」的源，值得盯            |
| `chrome-dev`           |  59d |              120 |                                           |
| `spring-boot-releases` |  56d |              120 |                                           |
| `ts-devblog`           |  43d |              120 |                                           |
| `react-releases`       |  30d |              180 | React 本来就发得稀                        |
| `node-releases`        |  15d |               60 |                                           |
| `eslint-releases`      |  13d |               60 |                                           |
| `anthropic`            |   9d |               60 | 镜像 + 官方发布本就不密集                 |
| `zhangxinxu`           |   6d |               60 | 月更节奏                                  |
| `pnpm-releases`        |   2d |               60 |                                           |
| `vitest-releases`      |   2d |               60 |                                           |
| `react-blog`           | 0.5d |              180 | 当天恰好有更新，但 react.dev 一年只发几篇 |
| `martinfowler`         | 0.5d |               90 | 同上，他一向能连着几个月不发              |

最后两行是重点：**阈值要按这个源的历史节奏定，不是按它今天碰巧多新。**

### 9.3 第三个信号：feed 完全不带 per-item 日期

这一条原本记在这里是「一个已知盲点」，前提是「目前所有 RSS 源都带日期（2026-08-20 实测）」。
**这个前提在 2026-09-02 被推翻了**，所以它现在是一个真正的检查，而不是一段注意事项。

盲点的机制：`normalize()` 会给没有日期的条目盖上**当前时间**（`toIsoDate` 的 fallback）。
于是一个完全不带 `pubDate` / `published` 的 feed，每一期都显示「最新条目 0 小时前」，
`staleAfterDays` 永远不可能被触发，运行摘要那列「最新」也永远是绿的。

踩中它的是 `meituan-tech`：

```bash
$ curl -s https://tech.meituan.com/feed/ | grep -c '<item'      # 10
$ curl -s https://tech.meituan.com/feed/ | grep -c '<pubDate'   #  1  ← 只有 channel 级
```

10 个条目、0 个条目级日期。它在 25 期里只有 9 期出过内容，而且集中在前段 —— 但**没有任何
告警**，因为它每期都「刚发布」。真正让它安静下来的是跨天去重把重复条目当成已见丢掉，
那是个副作用，不是监控。美团技术团队最后一篇实际上停在 2026-08-27。

检测方式是**精确判定而不是启发式**：fallback 用的是 `now.toISOString()`，所以一批无日期条目
会带上运行时钟、精确到毫秒。真实 feed 做不到这件事 —— 一条都做不到，何况全部。
实现见 [`findUndatedSources`](../src/core/health.ts)，告警文案是

```
source "meituan-tech" ships no per-item dates: all items were stamped with the run clock,
so the staleness check is blind to it
```

它**单独成一行、不算作停更**：这个源不是「已知停更」，是「无法监控」。收到这条告警的正确
反应只有两个 —— 换掉这个 feed，或者明确接受它没有健康信号。`meituan-tech` 选了后者：
Google News `site:tech.meituan.com` 实测回的是「历史文章」「美团 BERT 的探索和实践」这类
陈年归档页，比原 feed 更差。

### 9.4 45 期归档实测（2026-08-20 → 2026-09-02）

数据源是 `archive/**.json` 的 `warnings` 与 `items` 两个字段，覆盖 45 次真实运行
（morning 14 / evening 12 / news-am 10 / news-pm 9）。期间 `brief.config.yaml` 改过 6 版，
所以统计按**每期当时那版 config** 还原「这一期到底该抓哪些源」，不是拿今天的配置倒推。

读这张表之前必须先分开两个指标，否则会得出完全错误的结论：

| 指标           | 怎么算                                    | 说明                                                       |
| -------------- | ----------------------------------------- | ---------------------------------------------------------- |
| **抓取成功率** | `warnings` 里有没有这个源的失败/空/停更行 | 硬证据，这才是「抓没抓到」                                 |
| **上榜率**     | 这个源有几条进了最终 `items`              | 受 `limit` 席位、时间窗、跨天去重三重挤压，**低 ≠ 抓不到** |

`tech` 栏 17 个源抢 6 席，所以那一栏的上榜率天然就低。把上榜率当健康指标会误杀低频源。

**① 稳定抓取（45 期 0 告警，且几乎每期都有产出）—— 26 个源**

新闻侧是最健康的一块，Google News 系（`gn-*`）和中新网系（`chinanews-*`）全部满勤：

| 栏目      | 源                                                                                           | 命中/尝试 |
| --------- | -------------------------------------------------------------------------------------------- | --------- |
| `news`    | `bbc-world`                                                                                  | 27/27     |
| `news`    | `aljazeera` `guardian-world`                                                                 | 26/26     |
| `news`    | `ft-world` `gn-world-zh` `npr-news` `nyt-home` `nyt-world` `rfi-zh`                          | 19/19     |
| `cn-news` | `chinanews-china` `chinanews-finance` `cna-zh` `gn-business-zh` `gn-nation-zh` `scmp-china`  | 19/19     |
| `cn-news` | `chinanews-import` 18/19 · `gnews-cn` 25/26                                                  | ≥ 95%     |
| `cn-life` | `chinanews-society` `gn-disaster` `gn-edu` `gn-food` `gn-govcn` `gn-health-zh` `gn-minsheng` | 19/19     |
| `tech`    | `lobsters` 26/26 · `hn-front` 25/26                                                          | ≥ 96%     |

次一档（同样 0 告警，上榜 50–90%，掉的是席位不是抓取）：`solidot` 23/25 · `bbc-zhongwen` 23/26
· `thepaper` 22/26 · `infoq-cn` 21/25 · `verge` 21/26 · `oschina` 20/25 · `hacker-news-sec` 19/25
· `infoq-arch` 18/25 · `sspai` 14/25 · `gn-science-zh` 13/19 · `ars-technica` 13/26 · `nyt-cn` 12/19
· `simonwillison` 11/25。

**② 偶尔抓不到（抓取本身会间歇失败）**

| 源        | 失败      | 错误                                           | 失败分布                   |
| --------- | --------- | ---------------------------------------------- | -------------------------- |
| `jiemian` | 7/19 =37% | 全是 `TypeError: fetch failed`（连接层）       | 集中在 news-am（UTC 凌晨） |
| `36kr-ai` | 5/25 =20% | `AbortError` ×4（20s 超时）、`fetch failed` ×1 | 分散                       |

两个都已处置（§7）。`jiemian` 的关键证据是：同一时刻本机抓得到 —— 所以不是源坏了。

**③ 经常抓不到**

| 源         | 症状                                         | 频率                 |
| ---------- | -------------------------------------------- | -------------------- |
| `juejin`   | `200 + 0 条`（HTTP 正常，body 是空壳）       | 15/25 =60%           |
| `smashing` | `fetch failed` / `terminated` / `AbortError` | 5/25 =20%，且 0 上榜 |

`juejin` 是「假活」的教科书例子：传输层完全正常，内容为空。它触发的正是 §9.1 表里第一个信号。

**④ 从没抓到过**

真正 45 期一次都没成功的只有 **1 个**：

| 源        | 情况                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------ |
| `mingpao` | 19/19 期 `HTTP 403`。本机同一时刻正常（11 条、最新 6.8 小时）→ 明报按 IP 段封机房，runner 上无解 |

另有 5 个源**抓取一直成功、但从没产出过内容**，观感和「抓不到」一样，成因完全不同 ——
它们的最新条目一直在 24 小时窗口之外：

| 源           | 抓取 | 最新条目 | 为什么不上榜                                               |
| ------------ | ---- | -------: | ---------------------------------------------------------- |
| `react-blog` | 200  |    190 d | 超 `staleAfterDays: 180`，**20/25 期报停更 —— 这是真阳性** |
| `web-dev`    | 200  |     96 d | 预算 180 d，够不到阈值 → 静默                              |
| `chrome-dev` | 200  |     72 d | 预算 120 d → 静默                                          |
| `ts-devblog` | 200  |     55 d | 预算 120 d → 静默                                          |
| `anthropic`  | 200  |     35 h | 周级更新，35 h 已经出了 24 h 窗口                          |

`react-blog` 那 20 条告警**不要靠调大 `staleAfterDays` 消掉**（§9.2 的规矩）：react.dev 确实
从 2026-02-24 起没发过东西，告警是对的。等它超过一年再重新决定留不留。

**⑤ 一个统计口径的坑**

`releases` 栏 `enabled: false`，所以那 8 个 GitHub releases 源在这 45 期里**一次都没被抓过**。
按栏目展开源清单时若不过滤 `section.enabled`，会把它们统计成「8 个源 100% 抓不到」。
盘源健康时记得先看这个开关。

### 9.5 每次运行都能看见

运行摘要的「抓取」表多了一列 **最新**，是该源本次返回的最新条目的年龄（`8h` / `30d`）。
它的作用是让一个正在滑向停更的源在触发告警之前就被看见 —— 一整列 ✅
只说明请求成功了，不说明内容还活着。
