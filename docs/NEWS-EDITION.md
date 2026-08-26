# 要闻期（`news-am` / `news-pm`）实施计划

> 状态：**已实施**（2026-08-24）—— §4 的 8 个步骤全部落地，§5 的 1/2/3/6*/8*/9* 已验；
> 带 * 的三条要等第一次真跑，§5-4 / §5-5 的 runner 侧 dry-run 仍待执行（§6 风险 1）。
> 实施中与本文档的两处出入记在文末「实施记录」。
> 目标：在早报 / 晚报之外新增**两期独立的新闻期**，只跑国际 + 国内 + 民生三个栏目，
> 只发邮件。技术早晚报回归纯技术，新闻从此有自己的席位和时间。
> 探测时间：**2026-08-24**，从一台中国大陆的机器发起。runner 侧可达性另见 §6。

## 已定决策

| #   | 决策                                                | 影响                                                                               |
| --- | --------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 1   | **新增「一期」而不是给早报加栏目**                  | 分期机制已存在，纯配置；新闻自带一套席位，不与技术栏抢 `limit`                     |
| 2   | **一天两期：`news-am` 07:40 / `news-pm` 19:10**     | 避开 `:00` `:30`（全球 Actions 最拥挤的两分钟），同早晚报的既有理由                |
| 3   | **只发邮件（`recipients: [me-mail]`）**             | 企微 4096 字节上限不再是约束，席位可放到 30；企微移除后这行改回 `['*']` 或删掉     |
| 4   | **早报/晚报/周报的 `sections` 从 `['*']` 改白名单** | 不改则新闻栏一天被抓四遍、周报被 7 天新闻淹掉                                      |
| 5   | **席位 12 / 10 / 8 = 30 席/期**                     | `limit` 贴着源数（14 / 12 / 9），零浪费；再长只能加源，不能调 `limit`（见 §1.3）   |
| 6   | **权重中文源优先**                                  | `LLM_API_KEY` 暂不配置 → 英文源不会被翻译成中文一句话（见 §0.2）                   |
| 7   | **不外发**                                          | `publish.include` 是白名单且不含新闻栏，保持原样 —— 时政不进掘金 / Notion          |
| 8   | **`llm.budget.maxItemsPerRun` 12 → 24**             | 现值把早晚报的要闻栏饿死（见 §0.3）；改了也不涨钱，`topPerSection: 3` 仍是实际闸门 |
| 9   | **`chinanews-scroll` 不接**                         | 全类目滚动，与已接的 5 个 chinanews 频道内部重叠，会白占轮换位（见 §3）            |

---

## 0. 现状核查（实测，不是推断）

### 0.1 分期机制已经存在，加一期是纯配置

`schedules[]` 每条 = 一期，`id` 直接成为归档 slot（`2026-08-24.morning.json`）：

- [`src/archive/paths.ts:21`](../src/archive/paths.ts#L21) 自动拼后缀 —— 不用改
- [`src/core/pipeline.ts:141`](../src/core/pipeline.ts#L141) `slotFor` 在「启用的 schedule > 1」时就带 slot —— 已满足
- [`src/publish/collect.ts:107`](../src/publish/collect.ts#L107) `slotRank` 从 `schedules[].time` 读顺序 —— 自动正确
- `publish.window.slots: [morning, evening]` 写死两期 —— 新 slot 天然不会被外发

要改代码的只有一处：[`src/publish/adapt.ts:66`](../src/publish/adapt.ts#L66) 的 `SLOT_LABELS` 只有三个中文标签，
新 slot 会在站点和页脚里裸奔显示 `news-am`。

### 0.2 ★ LLM 从来没跑过 —— 这决定了权重怎么配

扫 `archive/2026/08/` 全部 9 期、166 条：

```
2026-08-20.json          items=22   withSummary=0 digest=false
2026-08-22.morning.json  items=22   withSummary=0 digest=false
2026-08-24.morning.json  items=17   withSummary=0 digest=false
2026-08-24.weekly.json   items=30   withSummary=0 digest=false   (全 9 期同此)
```

`llm.enabled: true`，但 `apiKeyRef: LLM_API_KEY` 这个 secret 没配 —— 正是配置注释预告的行为：
「密钥没配的时候整段自动跳过，早报照常出」。

**后果**：`llm.sections.news` 配的 `style: oneline` 中文一句话是国际栏唯一的翻译层，现在不存在。
英文源进邮件就是原样英文 excerpt：

```
[news/bbc-world] "The president took a ceremonial lap of the track before the race, which is..."
```

所以 §2 的权重表**按「LLM 未开」配**：中文源全部压在英文源之上。
配上 key 之后应回来把权重调平 —— 这是本文档里唯一一处「将来要回滚的临时值」。

### 0.3 `maxItemsPerRun: 12` 目前把要闻栏饿死了

额度按栏目顺序发放（[`src/enrich/policy.ts:212`](../src/enrich/policy.ts#L212)），
早报里 tech(3) + ai(3) + cn-tech(3) + security(2) = 11，轮到 `news` 只剩 1 席，`cn-news` 归零。

新闻期是独立 run（3 栏 × `topPerSection: 3` = 9 < 12），不受影响；
但顺手把 `maxItemsPerRun` 提到 24 可以修好早晚报的这个饿死问题。
**不会涨钱**：早晚报的实际用量仍被 `topPerSection: 3` 卡在 12。

> `topPerSection` 与 `maxItemsPerRun` 都是**全局**的，schema 里没有 per-section 覆盖
> （[`src/config/schema.ts:281`](../src/config/schema.ts#L281) / [`:333`](../src/config/schema.ts#L333)）。
> 想让新闻期每栏摘要超过 3 条，是改代码，不是改配置。本期不做。

### 0.4 `gnews-cn` 的 excerpt 是噪音，且永远不会被改写

实测归档里的样子：

```
[cn-news/gnews-cn] "中农批宿迁市场：…检测结果合格 东方财富 针对甲醛白菜三部门出手 观察者 …新浪财经"
```

Google News 把「同题相关报道列表」塞进了 `description`。两个后果：

1. 邮件里是纯噪音；
2. 它长度 > 80，会撞上 `llm.when.excerptShorterThan: 80` 被判为「源摘要已经够用」→
   **就算将来配了 key 也永远不会被摘要**。

对策：所有 Google News 源降权（见 §2），并加 §4 步骤 3 的 `stripPatterns`。

---

## 1. 编排设计

### 1.1 两期 schedule

| id        | 时间    | `lookbackHours` | 理由                                                            |
| --------- | ------- | --------------: | --------------------------------------------------------------- |
| `news-am` | `07:40` |              24 | 24h 保证「晚间那期跳过」时早间仍能兜住，同 `morning` 的既有理由 |
| `news-pm` | `19:10` |              12 | 上溯到 07:10，盖住 07:40 那期并留 30 分钟吸收排队漂移           |

两期均 `sections: [news, cn-news, cn-life]`、`recipients: [me-mail]`。
窗口重叠不会重复推送：跨天去重会读到当天已归档的 JSON（`archive.dedupeLookbackDays: 14`）。

生成的 cron（`pnpm brief:schedule` 产出，不要手写）：

```
40 23 * * *   news-am - 07:40 Asia/Shanghai（前一 UTC 日）
10 11 * * *   news-pm - 19:10 Asia/Shanghai
```

### 1.2 三个栏目

`news` / `cn-news` **沿用原 id** —— 已归档的 2026-08-20 那期用的就是这两个 id，
改名会让 `--from-archive` 重发时丢掉整栏。

| 栏目      | 标题      | 源数 | limit |
| --------- | --------- | ---: | ----: |
| `news`    | 国际要闻  |   14 |    12 |
| `cn-news` | 国内要闻  |   12 |    10 |
| `cn-life` | 民生·社会 |    9 |     8 |
| 合计      |           |   35 |    30 |

### 1.3 为什么 `limit` 贴着源数，而不是更大

`minPerSource: 1` 让席位先按「每源保底一条」发放。
`limit` 一旦大于源数，多出来的席位全给排名最高的那个源连发 ——
把「面」换成「同一家媒体刷屏」，而重大新闻要的恰恰是面。

所以**源数就是 `limit` 的天然上限**，想更长只能加源。
留 2 席差额（14→12 / 12→10 / 9→8）是给轮换的余量：低频源有机会顶上来。

### 1.4 一个必须知道的约束：两期条数必然相同

`limit` 是 section 的属性，两期共用同一套 section，所以做不到「早间 30 / 晚间 15」。
要区分就得建两套 section（id 不能重复），代价是归档里多三个栏目 id。**本期不做。**

### 1.5 长度账

30 席 × 2 期 = **每天 60 条新闻**，加上早晚报的技术条目（17 × 2 = 34）≈ **94 条/天**。
觉得多就调 `limit` —— 一行、零迁移、不用重新生成 cron。

---

## 2. 源清单（全部 2026-08-24 实测：可达、非空、UTF-8、日期可解析）

`n` = 实测条数，`龄期` = 最新条目距探测时刻的天数。★ = 本次新增。

### 2.1 `news` 国际要闻（14 源 / limit 12）

| 源                 | 端点                                                |   w |   n | 龄期 | 备注                       |
| ------------------ | --------------------------------------------------- | --: | --: | ---- | -------------------------- |
| `bbc-zhongwen`     | `feeds.bbci.co.uk/zhongwen/simp/rss.xml`            | 1.2 |   — | —    | 现有，从 `cn-news` 移入    |
| `nyt-cn` ★         | `cn.nytimes.com/rss.html`                           | 1.1 |  20 | 0.2d | 纽时中文网                 |
| `rfi-zh` ★         | `rfi.fr/cn/rss`                                     | 1.0 |  30 | 0d   | 法广中文                   |
| `un-news-zh` ★     | `news.un.org/feed/subscribe/zh/news/all/rss.xml`    | 0.9 |  30 | 0.9d | 机构口径                   |
| `bbc-world`        | `feeds.bbci.co.uk/news/world/rss.xml`               | 0.9 |   — | —    | 现有                       |
| `guardian-world`   | `theguardian.com/world/rss`                         | 0.8 |   — | —    | 现有，已有 `stripPatterns` |
| `nyt-world` ★      | `rss.nytimes.com/services/xml/rss/nyt/World.xml`    | 0.8 |  58 | 0d   | 量大，靠 `limit` 压        |
| `aljazeera`        | `aljazeera.com/xml/rss/all.xml`                     | 0.8 |   — | —    | 现有                       |
| `nyt-home` ★       | `rss.nytimes.com/services/xml/rss/nyt/HomePage.xml` | 0.7 |  20 | 0d   | 头版，含非国际             |
| `npr-news` ★       | `feeds.npr.org/1001/rss.xml`                        | 0.7 |  10 | 0.2d | 条数克制                   |
| `ft-world` ★       | `ft.com/world?format=rss`                           | 0.7 |  25 | 0d   | 财经视角                   |
| `economist-week` ★ | `economist.com/the-world-this-week/rss.xml`         | 0.7 | 300 | 2.6d | 周刊，**必须 `limit: 50`** |
| `gn-world-zh` ★    | Google News 国际（中文，见 §2.4）                   | 0.6 |  27 | 0d   | 兜底，无法与直连源去重     |
| `un-news-en` ★     | `news.un.org/feed/subscribe/en/news/all/rss.xml`    | 0.6 |  30 | 1.9d | 低频                       |

### 2.2 `cn-news` 国内要闻（12 源 / limit 10）

| 源                    | 端点                                         |   w |   n | 龄期 | 备注                      |
| --------------------- | -------------------------------------------- | --: | --: | ---- | ------------------------- |
| `chinanews-import` ★  | `www.chinanews.com.cn/rss/importnews.xml`    | 1.2 |  30 | 0d   | **主源**                  |
| `chinanews-china` ★   | `www.chinanews.com.cn/rss/china.xml`         | 1.1 |  30 | 0d   |                           |
| `jiemian` ★           | `a.jiemian.com/index.php?m=article&a=rss`    | 1.0 |  30 | 0d   | 界面新闻                  |
| `thepaper`            | Google News `site:thepaper.cn`（`when:24h`） | 0.9 |   — | —    | 现有，澎湃无官方 feed     |
| `chinanews-finance` ★ | `www.chinanews.com.cn/rss/finance.xml`       | 0.9 |  30 | 0d   | **`cj.xml` 是 404**       |
| `cna-zh` ★            | `feeds.feedburner.com/rsscna/mainland`       | 0.8 |  20 | 0.1d | 中央社，第三方中转        |
| `gn-nation-zh` ★      | Google News 国内（中文，见 §2.4）            | 0.8 |  43 | 0d   | 兜底                      |
| `mingpao` ★           | `news.mingpao.com/rss/pns/s00001.xml`        | 0.8 |  12 | 0.5d | 港闻                      |
| `scmp-china` ★        | `scmp.com/rss/4/feed`                        | 0.7 |  50 | 0.1d | 英文写中国，视角互补      |
| `gn-business-zh` ★    | Google News 财经（中文，见 §2.4）            | 0.7 |  32 | 0d   | 兜底                      |
| `yahoo-hk` ★          | `hk.news.yahoo.com/rss/hong-kong`            | 0.7 |  30 | 0.4d | 港闻                      |
| `gnews-cn`            | Google News 中文头条                         | 0.6 |   — | —    | 现有，**降权**（见 §0.4） |

### 2.3 `cn-life` 民生·社会（9 源 / limit 8）

| 源                    | 端点                                          |   w |   n | 龄期 | 备注        |
| --------------------- | --------------------------------------------- | --: | --: | ---- | ----------- |
| `chinanews-society` ★ | `www.chinanews.com.cn/rss/society.xml`        | 1.2 |  30 | 0d   | **主源**    |
| `chinanews-life` ★    | `www.chinanews.com.cn/rss/life.xml`           | 1.0 |  16 | 1.2d | 生活服务    |
| `gn-minsheng` ★       | 检索：民生 / 社保 / 医保 / 就业 / 房价 / 物价 | 0.9 | 100 | 0d   | `limit: 40` |
| `gn-disaster` ★       | 检索：台风 / 暴雨 / 地震 / 应急 / 预警        | 0.9 | 100 | 0d   | `limit: 40` |
| `gn-govcn` ★          | 检索：`site:gov.cn when:24h`                  | 0.8 | 100 | 0d   | 政策原文    |
| `gn-health-zh` ★      | Google News 健康（中文，见 §2.4）             | 0.7 |  70 | 0.1d |             |
| `gn-food` ★           | 检索：食品安全 / 药品 / 抽检 / 召回           | 0.7 | 100 | 0d   | `limit: 40` |
| `gn-edu` ★            | 检索：教育 / 高考 / 义务教育 / 招生           | 0.6 | 100 | 0d   | `limit: 40` |
| `gn-science-zh` ★     | Google News 科学（中文，见 §2.4）             | 0.5 |  18 | 0.4d |             |

### 2.4 Google News 端点的两个坑

**① 可读路径会 302，配置里必须写重定向后的 id。**
`/rss/headlines/section/topic/WORLD` 会跳到 `/rss/topics/<base64>`。已解析好的：

| 频道 | 完整端点（后接 `?hl=zh-CN&gl=CN&ceid=CN:zh-Hans`）                                          |
| ---- | ------------------------------------------------------------------------------------------- |
| 国际 | `news.google.com/rss/topics/CAAqKggKIiRDQkFTRlFvSUwyMHZNRGx1YlY4U0JYcG9MVU5PR2dKRFRpZ0FQAQ` |
| 国内 | `news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSkwyMHZNR1F3TlhjekVnVjZhQzFEVGlnQVAB`       |
| 财经 | `news.google.com/rss/topics/CAAqKggKIiRDQkFTRlFvSUwyMHZNRGx6TVdZU0JYcG9MVU5PR2dKRFRpZ0FQAQ` |
| 健康 | `news.google.com/rss/topics/CAAqJQgKIh9DQkFTRVFvSUwyMHZNR3QwTlRFU0JYcG9MVU5PS0FBUAE`        |
| 科学 | `news.google.com/rss/topics/CAAqKggKIiRDQkFTRlFvSUwyMHZNRFp0Y1RjU0JYcG9MVU5PR2dKRFRpZ0FQAQ` |

**② 标题带「 - 来源名」后缀，且来源名是中文。**
现有的 `gnews-cn` 只匹配 ASCII 域名形状（`- thepaper.cn`），对
`- 湖南红网` / `- 甘肃省人民政府` / `- 新华网客户端` 无效。
必须补一条中文后缀模式 —— 这不是美观问题：仓库自己实测过，
**共享后缀能把 4-gram 相似度刷到 0.327，比真正的跨源转载（0.286）还高**，
会把 `dedupe.titleSimilarity: 0.2` 从去重器变成误杀器。

---

## 3. 实测淘汰的源（记下来，省得下次重评）

| 候选                                                                                                                 | 实测结果                                               | 结论                                             |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------ |
| **人民网** politics/society/world                                                                                    | 200、100 条、结构完好、**冻结在 2025-06-05（445 天）** | 典型静默失效，不接                               |
| **新华网** `news_politics.xml`                                                                                       | 冻结 2022-12-14，且 `pubDate` 标签残缺                 | 日期解析不出 → 会被窗口全丢                      |
| **中国日报** `rss/china_rss.xml`                                                                                     | 条目停在 2017，无 `pubDate` 字段                       | 死源                                             |
| `chinanews-scroll`                                                                                                   | 200、30 条、0d，**活的**                               | 与已接 5 个 chinanews 频道重叠，白占轮换位，不接 |
| CNN `edition_world`                                                                                                  | 龄期 1071 天                                           | 死源                                             |
| 新浪 `focus15` / `marquee/ddt`                                                                                       | 龄期 2891 天 / 仅 1 条且无日期                         | 死源                                             |
| 网易 / 一财 / 财新 / 观察者网 / 环球网                                                                               | 返回 HTML 壳                                           | 不是 XML                                         |
| Reuters · AP · 联合早报 · 凤凰 · 央视 · 证券时报 · 新京报 · 南周 · 财联社 · 21世纪 · 参考消息 · 中青报 · hk01 · 每经 | 404 / 401 / ECONNRESET                                 | 公开 feed 已停                                   |
| DW 中文 / VOA 中文                                                                                                   | ECONNRESET                                             | 本机网络所致，runner 上可能不同                  |
| france24 中文 / 日经中文                                                                                             | 404 / 403                                              | 不接                                             |
| RSSHub 公共镜像 `rssforever`                                                                                         | 503                                                    | 与 `SOURCES.md` §7 记录一致                      |

---

## 4. 实施步骤

### 步骤 1 — `brief.config.yaml` › `schedules`

加 `news-am` / `news-pm` 两条（参数见 §1.1），
并把 `morning` / `evening` 的 `sections: ['*']` 改成
`[tech, ai, cn-tech, security, releases]`。

> `releases` 当前 `enabled: false`，写进白名单只是为了将来重新打开时不用记得回来补。

### 步骤 2 — `brief.config.yaml` › `weekly.sections`

`['*']` → `[tech, ai, cn-tech, security, releases]`。
不改则每周回顾会把 7 天新闻卷进来（3 栏 × `limitPerSection: 5` = 多出 15 条）。

### 步骤 3 — `brief.config.yaml` › `sources`

新增 29 个源（§2 三张表里带 ★ 的）。三个必须写对的参数：

- `economist-week` → `params.limit: 50`（源有 300 条）
- 所有 `gn-*` 检索源 → `params.limit: 40`（对齐现有 `gnews-cn` / `thepaper`）
- 所有 `gn-*` 源 → `stripPatterns` 补中文来源后缀模式（§2.4 ②）

`staleAfterDays` 一律不写：实测龄期全部 ≤ 2.6 天，默认 30 天足够。

### 步骤 4 — `brief.config.yaml` › `sections`

`news` / `cn-news` 扩源改 `limit`，新增 `cn-life`；
把 `sections:` 上方注释里的「每日上限 22 条」改成早晚报的新数值。

### 步骤 5 — `brief.config.yaml` › `llm`

- `budget.maxItemsPerRun`: 12 → 24（理由见 §0.3）
- `sections` 补两条：
  `cn-news: { summarize: true, style: oneline, maxChars: 120 }`（**现在根本没配，等于永不摘要**）
  `cn-life: { summarize: true, style: oneline, maxChars: 120 }`

> 这两条现在不生效（key 未配），是为配上 key 那天准备的。

### 步骤 6 — `src/publish/adapt.ts`

`SLOT_LABELS` 加两项：`'news-am': '早间要闻'`、`'news-pm': '晚间要闻'`。

### 步骤 7 — 重新生成 cron

```bash
pnpm brief:schedule       # 改写 .github/workflows/daily-brief.yml 的 BEGIN/END 段
pnpm check:schedule       # 不跑这步，CI 会红
```

### 步骤 8 — 文档同步

- `docs/SOURCES.md`：§0 全局表加三栏、正文加三节源表、§7 追加 §3 的淘汰清单
- `README.md`：源数 51 → 80、栏目数、新增两期的说明
- `TODOs.md`：「抓取资源配置要写清来源URL和条数」—— 本文档 §2 已满足，可勾掉

---

## 5. 验收标准（每条都可执行）

| #   | 验证                                                                  | 期望                                                    |
| --- | --------------------------------------------------------------------- | ------------------------------------------------------- |
| 1   | `pnpm validate`                                                       | 配置通过 zod，无报错                                    |
| 2   | `pnpm check:schedule`                                                 | 通过（cron 与配置一致）                                 |
| 3   | `pnpm typecheck && pnpm lint && pnpm test`                            | 全绿                                                    |
| 4   | `gh workflow run daily-brief.yml -f dry-run=true -f schedule=news-am` | 出报；**逐个检查「抓取告警」段落**（§6 风险 1）         |
| 5   | 同上，查早报未受影响：`-f schedule=morning -f dry-run=true`           | 只出 4 个技术栏，**不含 news / cn-news / cn-life**      |
| 6   | 真跑一期后看归档                                                      | `archive/2026/08/<date>.news-am.json` 存在，slot 正确   |
| 7   | 看站点                                                                | `site/2026/08/<date>.news-am.html` 标题显示「早间要闻」 |
| 8   | 看邮件                                                                | 三栏齐全、≈30 条、企微**没有**收到这一期                |
| 9   | 看发布                                                                | 掘金 / Notion 当天内容**不含**任何新闻条目              |

---

## 6. 风险与对冲

| #   | 风险                                                            | 对冲                                                                  |
| --- | --------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1   | **runner 在美国**，中文源可达性未验证（本次全部从大陆机器探测） | 验收 §5-4 的 dry-run 是唯一判据；挂了只出告警不影响出报，逐个换掉即可 |
| 2   | Google News 源**无法与直连源自动去重**（跳转 URL + 标题后缀）   | 全部降权到 ≤ 0.9，并加 §2.4 ② 的 `stripPatterns`                      |
| 3   | 中文后缀 `stripPatterns` 可能误删正常标题尾巴                   | 先跑一次 dry-run 逐条肉眼看标题，确认后再信任 `titleSimilarity`       |
| 4   | 5 个 `chinanews-*` 同域频道之间有重叠                           | 靠 `dedupe.titleSimilarity: 0.2` 吃掉；已排除重叠最大的 `scroll`      |
| 5   | `cna-zh` 走 feedburner（第三方中转），随时可能停                | 同 `36kr-ai` 的既有风险模型：挂了只留告警，权重已压到 0.8             |
| 6   | 无 LLM，英文源不翻译                                            | 权重表已中文优先；配上 key 后回来调平（§0.2）                         |
| 7   | 每天 94 条，邮件偏长                                            | `limit` 是一行改动、零迁移；先跑一周再定                              |

---

## 7. 回滚

把两条 schedule 的 `enabled` 改成 `false`，跑一次 `pnpm brief:schedule`。
源声明、栏目声明、`SLOT_LABELS` 全部留着 —— 不发一次 HTTP 请求，也不产生告警，
`--sections cn-life` 仍然校验得过。已归档的要闻期文件不受影响。

---

## 8. 实施记录（2026-08-24 落地后补）

两处与上文不一致的地方，以这里为准：

1. **§0.1 说「要改代码的只有一处」，实际是两处。** `SLOT_LABELS` 当时只被
   [`src/publish/adapt.ts`](../src/publish/adapt.ts) 的页脚用到，静态站
   ([`src/site/render.ts`](../src/site/render.ts)) 一直是直接打印 slot id 的 ——
   照原计划只改 adapt.ts，§5-7 那条「站点标题显示『早间要闻』」永远不会通过。
   改法是把标签表提到 [`src/archive/paths.ts`](../src/archive/paths.ts)
   （`WEEKLY_SLOT` 已经在那里）导出 `slotLabel()`，页脚和站点共用一份。
   副作用：**已有的历史页面也跟着从 `morning` 变成「早报」**，这是想要的一致性。
   站内搜索的 `searchKey` 两种写法都收，搜 `morning` 和搜「早报」都能命中。
   渲染层页脚里的 `scheduleId`（`—— 每日早报 · news-am · Asia/Shanghai`）**没有改**：
   那一行是「哪次运行产出的」，写的是 `-f schedule=` 要填的那个 id，不是给人读的标签。

2. **`stripPatterns` 比 §2.4② 多了一条，中文那条也更宽。** 第一次 dry-run 的输出里
   逐条肉眼看（§6 风险 3 要求的那一步）发现两个漏网：
   - `- 中國報 China Press` —— 来源名是「中文 + 拉丁词」，只允许中文字符的模式吃不掉它，
     于是放宽为「中文开头 ≤ 15 字，后面最多再跟两个拉丁词」；
   - `gn-health-zh` 的 excerpt 末尾带「在 Google 新闻上查看更多头条新闻和观点」，
     是按钮文案，补了第三条模式。
     两条改动都只作用于 `gn-*` 源，且用 7 个真实标题 + 5 个正常标题验证过：该删的全删、
     正常标题一个没动。

一次本机（大陆）dry-run 的实际产出：**国际 12 / 国内 10 / 民生 8 = 30 条，无抓取告警**，
35 个源全部可达。runner（美国）侧仍未验证 —— 那是 §5-4 的事。
