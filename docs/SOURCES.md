# 源清单（Sources）

这份文档回答一个问题：**早报里的内容到底从哪来。**

数据的唯一真相是 [`brief.config.yaml`](../brief.config.yaml) 的 `sources` / `sections` 两段，
本文是它的可读版本 —— 逐源列出抓取端点、权重、栏目归属和「为什么是这个值」，
外加一份**没有接入的源**及其原因，免得下次重新踩一遍坑。

- 快照时间：**2026-08-20**
- 规模：**51 个源 / 3 种适配器 / 7 个栏目**，每日最多产出 **25 条**
- 所有 feed 均在 2026-08-20 实测过：可达、非空、UTF-8，且**逐个量过「最新条目距今多久」**（§9）
- 改源之后请回来同步这份文档，它不是自动生成的

---

## 0. 一张表看懂全局

| 栏目 id    | 标题     | 源数 | 每日 limit | 过滤规则                                                |
| ---------- | -------- | ---: | ---------: | ------------------------------------------------------- |
| `tech`     | 国际技术 |   18 |          6 | 排除 crypto / NFT / web3 / memecoin                     |
| `ai`       | AI 工程  |    7 |          4 | 无（`anthropic` 试运行期间从 3 提到 4）                 |
| `cn-tech`  | 中文技术 |    9 |          5 | 无（`36kr-ai` 试运行期间从 4 提到 5）                   |
| `security` | 安全公告 |    3 |          2 | 排除 ICS / 工控 / PLC / SCADA / Siemens / …             |
| `releases` | 依赖发版 |    8 |          3 | 排除 canary / nightly / -rc / -alpha / -beta / SNAPSHOT |
| `news`     | 国际要闻 |    3 |          3 | 无                                                      |
| `cn-news`  | 中文要闻 |    3 |          2 | 无                                                      |

按适配器分：`rss` 49 个、`hackernews` 1 个、`github` 1 个。
每个源都恰好属于一个栏目，没有孤儿源，也没有被两个栏目共用的源。

各栏 `limit` 相加 = **25**，这就是每日条数上限。加源的时候记得回头改
`brief.config.yaml` 里 `sections:` 上方那行注释里的数字 —— 它已经过期过一次。

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

## 2. `tech` 国际技术（18 源 / limit 6）

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

低频高相关，靠 `weight` 保住席位。若长期被日更源挤掉，把这几个拆成独立 section（`limit: 2`）即可。

| 源           | 端点                                                |   w |
| ------------ | --------------------------------------------------- | --: |
| `react-blog` | `https://react.dev/rss.xml`                         | 1.2 |
| `chrome-dev` | `https://developer.chrome.com/static/blog/feed.xml` | 1.2 |
| `web-dev`    | `https://web.dev/static/blog/feed.xml`              | 1.1 |
| `ts-devblog` | `https://devblogs.microsoft.com/typescript/feed/`   | 1.1 |
| `css-tricks` | `https://css-tricks.com/feed/`                      | 0.9 |
| `smashing`   | `https://www.smashingmagazine.com/feed/`            | 0.9 |

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

| 源             | 端点                                             |   w | 备注                                          |
| -------------- | ------------------------------------------------ | --: | --------------------------------------------- |
| `solidot`      | `https://www.solidot.org/index.rss`              | 1.1 |                                               |
| `oschina`      | `https://www.oschina.net/news/rss`               | 0.9 |                                               |
| `infoq-cn`     | `https://www.infoq.cn/feed`                      | 1.0 |                                               |
| `ruanyifeng`   | `http://www.ruanyifeng.com/blog/atom.xml`        | 1.3 | 周更，所以权重给满；注意是 **http**           |
| `meituan-tech` | `https://tech.meituan.com/feed/`                 | 1.2 |                                               |
| `zhangxinxu`   | `https://www.zhangxinxu.com/wordpress/feed/`     | 1.2 | 前端 CSS                                      |
| `juejin`       | `https://juejin.cn/rss`                          | 0.7 | 官方 RSS；分类参数是假的，只有全站流（见下）  |
| `36kr-ai`      | `https://rss.injahow.cn/36kr/motif/327686782977` | 0.9 | **第三方 RSSHub 镜像**，试运行中（见下 + §7） |
| `sspai`        | `https://sspai.com/feed`                         | 0.8 |                                               |

两个必须知道的坑，细节见 [`docs/CN-SOURCES.md`](./CN-SOURCES.md)：

- **掘金的分类参数是假的。** `?cate=frontend` / `?category=backend` 都返回 200 却给同一批文章
  （实测 frontend vs backend 重合 100%）。只能拿全站流，靠低 `weight`(0.7) 压权重。
  另外它的 feed 窗口只有约 4 小时 —— 发文密度太高，日更一次必然漏掉大半。
- **36氪 官方 feed 已死**（`/feed` 现在返回 SPA 的 HTML 壳）。当前走第三方 RSSHub 镜像的
  「人工智能·AI」专题路由，而不是 `/newsflashes`（那是财经通稿，且 20 条只覆盖 1.5 小时）。
  试运行不留就把 `cn-tech` 的 `limit` 调回 4 并删掉这个源。

---

## 5. 其余四栏

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

### `news` 国际要闻（3 源 / limit 3）

| 源               | 端点                                          |   w |
| ---------------- | --------------------------------------------- | --: |
| `bbc-world`      | `https://feeds.bbci.co.uk/news/world/rss.xml` | 1.1 |
| `guardian-world` | `https://www.theguardian.com/world/rss`       | 0.9 |
| `aljazeera`      | `https://www.aljazeera.com/xml/rss/all.xml`   | 0.9 |

### `cn-news` 中文要闻（3 源 / limit 2）

| 源             | 端点                                                                |   w | 备注                        |
| -------------- | ------------------------------------------------------------------- | --: | --------------------------- |
| `bbc-zhongwen` | `https://feeds.bbci.co.uk/zhongwen/simp/rss.xml`                    | 1.1 | 直连源                      |
| `thepaper`     | Google News 站内检索 `site:thepaper.cn`（`when:24h`，`limit:40`）   | 0.9 | 澎湃无官方 feed，走检索兜底 |
| `gnews-cn`     | Google News 中文头条 `hl=zh-CN&gl=CN&ceid=CN:zh-Hans`（`limit:40`） | 0.8 | 兜底，权重压低              |

**Google News 类源无法与直连源自动去重**：条目 URL 指向 `news.google.com` 跳转链接，
标题还带「 - 来源名」后缀，跟直连源的 id/标题都对不上。这是把它们权重压低的原因。

> 栏目 id 保持 `news` / `cn-news` 不变：已归档的 2026-08-20 那期用的就是这个 id，
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

### 第三方依赖的风险，说清楚

目前只有 `36kr-ai` 依赖**别人的服务器**（`rss.injahow.cn`）。它随时可能关停、限流或改变行为，
你的抓取行为对该实例运营者可见。挂掉时只会留一条抓取告警，不影响出报 —— 但要知道它会挂。
备选路线（自写 36kr adapter ≈80 行 / 自建 RSSHub）见 `docs/CN-SOURCES.md` §2 的方案 B、C。

### 还有一个前提：runner 在美国

所有中文源的可达性探测都是从中国大陆机器发起的，**这不能证明 GitHub Actions 抓得到**。
`ubuntu-latest` 的 runner 在美国。验证一次很便宜：

```bash
gh workflow run daily-brief.yml -f dry-run=true -f sections=cn-tech
```

然后看输出里的「抓取告警」段落，哪个源在 runner 上抓不到一眼就能看出来。

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

### 为什么 HTTP 200 不够

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

两者都只出**告警**，绝不让运行失败 —— 一个停更的源不该把整份早报带下水。

### `staleAfterDays` 怎么取值

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

### 每次运行都能看见

运行摘要的「抓取」表多了一列 **最新**，是该源本次返回的最新条目的年龄（`8h` / `30d`）。
它的作用是让一个正在滑向停更的源在触发告警之前就被看见 —— 一整列 ✅
只说明请求成功了，不说明内容还活着。

### 一个已知盲点

`normalize()` 会给**没有日期的条目**盖上当前时间。所以一个完全不带 `pubDate` /
`published` 的 feed，在这里永远不会显示为停更。目前 49 个 RSS 源全部带日期
（2026-08-20 实测），加新源时值得顺手确认一下这一点。
