# 一文多发 —— 实施计划（Notion + 掘金）

> 本期范围：**Tier 1 = Notion（官方 token）**、**Tier 2 = 掘金（Web 登录态）**。
> 其余平台（dev.to / Hashnode / 微信公众号 / CSDN / 知乎 / SegmentFault）列为 TODO，见 §12。
>
> 三条产品约束（全部来自需求方，本文围绕它们设计）：
>
> 1. **每天固定时间发一篇日报，每周固定时间发一篇周报**；
> 2. **只发技术内容，不发新闻**；
> 3. **移除新闻后条数要补回来，而且要更多**。
>
> 上游背景：[PLAN.md](./PLAN.md) §7「可选扩展」。与 [LLM-SUMMARY.md](./LLM-SUMMARY.md) 同级：那份讲「内容怎么变好」，这份讲「内容怎么出去」。

---

## 已定决策

| #   | 决策                                                 | 影响                                                                                                                 |
| --- | ---------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1 ★ | **不复用 `Channel`，新开 `Publisher`**               | 推送是「发完即忘」，发布是「创建一个有 ID、可编辑的资源」，幂等要求根本不同（§0.1）                                  |
| 2 ★ | **只读归档，但按窗口重新选材，不直取某一期**         | 「只发技术」和「条数要够」这两条要求，单期直取都满足不了；`collect.ts` 从归档窗口重建一期（§0.4、§1.3）              |
| 3 ★ | **两条发布线，各有自己的 cron**                      | 日报每天 09:30、周报周一 10:30，与早报的**生成**时间解耦；`publish.yml` 自持 cron，不挂 `workflow_run`（§0.3、§7.1） |
| 4 ★ | **栏目白名单，不是把新闻拉黑**                       | `include: [tech, ai, cn-tech, security, releases]`。以后新增栏目默认不外发，黑名单则会漏（§0.4）                     |
| 5 ★ | **条数三级杠杆：合并两期 → 提源头 limit → 开发版栏** | 实测 `tech`/`cn-tech` **每期都打满上限**，是真瓶颈；`ai`/`security` 是供给不足，提 limit 无效（§0.4）                |
| 6 ★ | **归档要富、推送要瘦**                               | 提高 `section.limit` 会连带撑长邮件，故新增 `recipients[].maxItemsPerSection`，源头扩容不牵连读者（§0.5）            |
| 7   | **幂等状态按「发布日 + 发布线」记，且记 `itemIds`**  | 文章不再一一对应某期归档，状态必须换主键；`itemIds` 是跨发布去重的唯一依据（§4）                                     |
| 8   | **缺 secret 是 skip，不是 fail**                     | 与 `channel.missingEnv()` 同一条规则：没配 Notion token 不该让掘金那一路变红（§1.2）                                 |
| 9   | **单 job 内并发，不用 workflow matrix**              | 每平台一个 job 都要写同一个 state 文件再 push，必然冲突；复刻 `deliver()` 的并发+隔离（§7.3）                        |
| 10  | **掘金分两阶段：试运行期草稿，稳定后转自动**         | 每天一篇的节奏下「永远人工点」不现实；用 burn-in + 熔断 + 告警替代人工闸门（§6.5、§7.4）                             |
| 11  | **`minItems` 质量闸门**                              | 条数不够的那天**不发**，宁可缺一期，也不发一篇干瘪的凑数文（§2.1、§8）                                               |
| 12  | **`catchUpDays` 补发窗口**                           | cron 到点时归档可能还没就绪（Actions 会漂 0–30 分钟）；次日自动补，而不是永久缺一期（§1.3）                          |
| 13  | **连续失败熔断**                                     | 连续 N 次失败即停止尝试并告警——在风控里反复撞墙只会让情况更糟（§8）                                                  |
| 14  | **cron 由配置生成 + 漂移守卫**                       | 复用现成的 [`src/schedule/`](../src/schedule/cron.ts)，`pnpm check:schedule` 一并守住 `publish.yml`（§7.2）          |
| 15  | **首发地是 GitHub Pages**                            | footer 强制写「本文首发于…」并列出取材期，canonical 关系诚实，也是搬运判定的护身符（§3.4）                           |
| 16  | **不做 Cookie 自动续期**                             | 需要额外 PAT + `gh secret set`，等于给 CI 一个改自己 secret 的权限；改为「过期即告警」（§6.2）                       |
| 17  | **不用无头浏览器**                                   | Puppeteer 比直接打 HTTP 脆弱一个数量级，且 CI 上装 Chromium 的时间超过整个发布流程（§12）                            |

---

## 0. 现状诊断

### 0.1 `Channel` 与 `Publisher` 是两个契约

[`src/channels/types.ts`](../src/channels/types.ts) 的 `Channel` 有三个隐含前提：消息没有身份、重发无害、发完就没了。这三条对掘金全部不成立。

| 维度     | `Channel`（现有）                | `Publisher`（新增）                                        |
| -------- | -------------------------------- | ---------------------------------------------------------- |
| 产物     | 一条消息                         | 一个资源：`postId` + URL                                   |
| 重跑     | 再推一次，无害                   | **再发一次 = 重复文章**，必须幂等                          |
| 失败语义 | `skipped` / `failed`，写 summary | 需要状态持久化 + 可续 + 可重试                             |
| 载荷     | `{title, body, blocks, text}`    | 还要 `tags` / `category` / `cover` / `brief` / `canonical` |
| 认证     | 一个 webhook 或 token            | Notion：长期 token；掘金：**会过期的登录态**               |
| 编辑     | 不存在                           | 内容变了要 `update`，不是再建一个                          |
| 选材     | 收件人拿到的就是那一期           | **要重新选材**：只留技术、跨期合并、按分数截断             |

**可以复用的是编排，不是数据契约。** [`deliver()`](../src/channels/index.ts) 的「并发 + 每目标独立 try/catch + 缺 env 即 skip」这套形状原样搬过来即可（§1.1 的 `publishAll()`）。

### 0.2 平台分级与本期范围

| Tier | 平台            | 认证                   | 本期 | 理由                                       |
| ---- | --------------- | ---------------------- | ---- | ------------------------------------------ |
| 1    | **Notion**      | 官方 Integration Token | ✅   | 长期有效、无风控、失败可诊断，先把骨架跑通 |
| 2    | **掘金**        | Web `sessionid` Cookie | ✅   | 目标平台；但**无官方开放发布 API**，见 §6  |
| 1    | dev.to          | `api-key` header       | TODO | 几十行，等抽象验完再加                     |
| 1    | Hashnode        | GraphQL PAT            | TODO | 2026 起 GraphQL API 转收费，先确认额度     |
| 1    | 微信公众号      | `access_token`         | TODO | **需 IP 白名单**，GitHub runner IP 不固定  |
| 2    | CSDN / 知乎     | Cookie                 | TODO | 等掘金这条路稳定运行满一个月再说           |
| 3    | Medium / 小红书 | —                      | ✗    | 官方发布通道已废/不存在，不做              |

**为什么先做 Notion 而不是直接上掘金**：Notion 这一路能把 §1 的抽象、§2 的选材、§3 的适配层、§4 的幂等状态机全部跑通并单测，而且失败原因永远是明确的 HTTP 错误。等这四块稳了，掘金适配器就只是「换一个 HTTP 序列」，不用同时调试抽象和风控。

### 0.3 发布节奏：两条线，各有固定时间

发布时刻由 `publish.yml` **自己的 cron** 决定，与早报什么时候跑完无关：

| 发布线   | 取材                       | 早报生成时间（现状） | 发布时间（新增） | 缓冲  |
| -------- | -------------------------- | -------------------- | ---------------- | ----- |
| `daily`  | 当天 `morning` + `evening` | 07:10 / 20:10        | **每天 09:30**   | 2h20m |
| `weekly` | 周一的 `weekly` 那期       | 周一 08:00           | **周一 10:30**   | 2h30m |

**缓冲为什么要 2 小时以上**：[PLAN.md](./PLAN.md) §0.4 记录 Actions 定时会漂 0–30 分钟，[LLM-SUMMARY.md](./LLM-SUMMARY.md) §3.2 记录早报自己要跑 3–5 分钟（最坏 6 分钟）。两端各漂一次再加运行时间，2 小时是能吸收「漂移 + 重试 + 没人在场」的量。时间刻意避开整点，理由同 LLM-SUMMARY 决策 8。

这个节奏带来三个必须正面处理的后果：

1. **不能再挂 `workflow_run`**。那样发布时刻 = 早报跑完那一刻，会跟着排队漂——与「固定时间」直接冲突。改成 cron 后，**「归档还没就绪」变成我方要处理的情况**，这正是 `catchUpDays`（§1.3）存在的原因。
2. **`daily` 只取 `morning` 是不够的**。见 §0.4——要合并当天两期才有足够的技术条数。
3. **周一会有两篇**。两个 cron 间隔 1 小时；不想要就给 `daily` 配 `skipWeekdays: [mon]`，周一只发周报。

### 0.4 ★ 只发技术之后，条数从哪来 —— 先量，再改

需求 2（不发新闻）和需求 3（条数要更多）必须放在一起解，因为**发布只能从归档里拿**——归档里没有的条目，publish 再聪明也变不出来。

对 `archive/2026/08/` 现有 9 期实测：

| section          | `limit` | 实测每期条数（8 期日报） | 判断                                |
| ---------------- | ------- | ------------------------ | ----------------------------------- |
| `tech`           | 6       | 6 6 6 6 6 6 6 6          | **每期都打满 → limit 就是瓶颈**     |
| `cn-tech`        | 5       | 5 5 5 5 5 5 5 5          | **每期都打满 → limit 就是瓶颈**     |
| `ai`             | 4       | 4 1 4 1 4 2 1 1          | 供给不足，提 limit 无效             |
| `security`       | 2       | 2 2 2 0 2 0 0 0          | 供给不足/源不稳，提 limit 无效      |
| `releases`       | 3       | —                        | **当前 `enabled: false`**，根本没抓 |
| `news`+`cn-news` | 3+2     | 5 5 5 5 5 5 5 5          | 本次要移除的                        |

**结论**：每期技术条目实测 **11–17 条**（中位 ~13），移除新闻后单期就是这个数；周报那期技术 20 条。

于是「补数量」有三级杠杆，**按性价比排序，建议只做前两级**：

| 级别  | 手段                                     | 增量                    | 代价                                                 |
| ----- | ---------------------------------------- | ----------------------- | ---------------------------------------------------- |
| **1** | **`daily` 合并当天 `morning`+`evening`** | 11–17 → **23–31 条/天** | 零成本，纯 publish 侧，本方案默认就这么做            |
| **2** | **提高 `tech` / `cn-tech` 的 limit**     | 每期再 +7 左右          | 会撑长邮件/推送 → 需要 §0.5 的 `maxItemsPerSection`  |
| 3     | 重新启用 `releases` 栏，但只给 publish   | 每期 +0–3               | 要开 `enabled: true` 再用 recipient 白名单挡住邮件   |
| —     | 给 `ai` / `security` 加源                | 不确定                  | 属于 [SOURCES.md](./SOURCES.md) 的单子，不在本文范围 |

**级别 1 大概率就够了**：一篇 23–31 条的技术日报，对掘金而言已经偏长，再多要靠 `maxItems` 截断。所以落地顺序是——**先做级别 1，用 M3 跑两周量真实条数，不够再动级别 2。**

栏目用**白名单**表达：

```yaml
include: [tech, ai, cn-tech, security, releases]
```

而不是 `exclude: [news, cn-news]`。理由：以后加了 `finance` 或 `culture` 栏，黑名单会**默认放行**，白名单会**默认拦住**。外发内容的默认值必须是「不发」。

### 0.5 归档要富、推送要瘦

级别 2 有个连带伤害：`section.limit` 是**全局**的，提高它会让归档变多，**也会让每个收件人的邮件和推送同步变长**。

现有能力挡不住这件事：[`restrictSections`](../src/core/brief.ts) 只按栏目白名单裁剪，不裁条数；`detail: compact` 只缩短每条的**长度**，不减少**条数**。

所以级别 2 必须配一个小改动——`recipients[].maxItemsPerSection`（可选，不设 = 现状）：

```yaml
recipients:
  - id: me-mail
    channel: email
    maxItemsPerSection: 6 # 邮件保持现在的体量
  - id: me-wecom
    channel: wecom
    maxItemsPerSection: 4 # 手机上更短
```

在 `renderForRecipients` 里于 `restrictSections` 之后按 `rankScore` 截断即可，**并入 §5.2 的渲染签名缓存 key**，否则两个不同上限的收件人会互相覆盖缓存（这个坑 `detail` 字段已经踩过一次，注释就在那儿）。

> 这一条只有真的走到级别 2 才需要做。M1–M3 不碰它。

---

## 1. 架构

### 1.1 模块划分

完全对称于 `src/channels/`——一文件一平台，一行注册表：

```
src/publish/
  types.ts     Publisher / PlatformArticle / PublishResult / PublisherContext
  index.ts     PUBLISHERS 注册表 + publishAll()（复刻 deliver 的并发与隔离）
  collect.ts   ★ 选材：归档窗口 → 栏目白名单 → 跨发布去重 → 排序截断
  state.ts     *.publish.json 的读写与幂等判定（纯函数，重点单测对象）
  adapt.ts     CollectedIssue → PlatformArticle（标题/摘要/标签/方言正文/footer）
  markdown.ts  markdown → Notion blocks（只在 Notion 一侧用）
  notion.ts    Tier 1
  juejin.ts    Tier 2
  stdout.ts    --dry-run 的落地目标（照抄 channels/stdout.ts）
src/publish.ts 入口（对应 `pnpm publish:run`），与 src/index.ts 平级
```

新增脚本：

```jsonc
"publish:run": "tsx src/publish.ts",
"publish:dry": "tsx src/publish.ts --dry-run",
"publish:schedule": "tsx src/schedule/generate.ts --write --workflow .github/workflows/publish.yml --kind publish",
```

### 1.2 数据模型

```ts
/** collect.ts 的产物：一篇待发文章的**内容**，还没有平台方言。 */
export interface CollectedIssue {
  /** 发布线 id：daily / weekly。 */
  scheduleId: string
  /** 发布日（本地时区），也是状态文件的主键之一。 */
  publishDate: string
  /** 取材自哪几期归档 —— footer 要把它们列出来。 */
  sources: Array<{ date: string; slot: string | null }>
  /** 已按栏目白名单过滤、跨发布去重、按 rankScore 排序并截断。 */
  sections: BriefSection[]
  /** 参与本次发布的 item id，写进状态供后续去重（§4.1）。 */
  itemIds: string[]
  /** 取窗口内最新一期的 digest；没有就降级（§3.3）。 */
  digest?: BriefDigest
}

/** 平台无关的一篇文章。adapt.ts 的产物，每个 Publisher 的输入。 */
export interface PlatformArticle {
  scheduleId: string
  publishDate: string
  title: string
  /** 平台方言的 markdown —— 不是归档里那一份，见 §3。 */
  markdown: string
  /** 列表页摘要。掘金的 brief_content，Notion 的 Summary 属性。 */
  brief: string
  tags: string[]
  category?: string
  coverUrl?: string
  /** 首发地址：窗口内最新一期在 Pages 上的 URL（§3.3）。 */
  canonicalUrl: string
  /** 决定 update 还是 skip，见 §4.3。 */
  contentHash: string
}

export type PublishStatus = 'created' | 'updated' | 'published' | 'skipped' | 'failed'

export interface PublishResult {
  target: string
  platform: string
  status: PublishStatus
  postId?: string
  url?: string
  /** 已经过 redact 的原因描述，可直接写进归档。 */
  detail?: string
  durationMs: number
}

export interface PublisherContext {
  env: NodeJS.ProcessEnv
  /** 复用 channels/types.ts 的 HttpFetch —— 测试里注入假实现，永不联网。 */
  fetchImpl: HttpFetch
  sleep: (ms: number) => Promise<void>
  log?: (message: string) => void
}

export interface Publisher {
  readonly name: string
  /** 缺的环境变量。非空 = skip，不是 fail（决策 8）。 */
  missingEnv(target: PublishTarget): string[]
  createDraft(a: PlatformArticle, t: PublishTarget): Promise<{ postId: string; url?: string }>
  updateDraft(postId: string, a: PlatformArticle, t: PublishTarget): Promise<void>
  /** 只有 target.autoPublish 为真才会被调用；Notion 不实现（创建即可见）。 */
  publish?(postId: string, t: PublishTarget): Promise<{ url: string }>
}
```

`publishAll()` 的形状与 `deliver()` 一致，只多两件事：**发布前查状态**、**发布后写状态**。

```ts
export async function publishAll(
  targets: PublishTarget[],
  options: PublishAllOptions,
): Promise<PublishResult[]> {
  return Promise.all(
    targets.map(async (target): Promise<PublishResult> => {
      // 1) enabled/schedules 命中 → 2) missingEnv → 3) decide(state, article)
      // → 4) 调用 → 5) 记录。每个 target 独立 try/catch：
      // 掘金 Cookie 过期不影响 Notion 那一路。
    }),
  )
}
```

### 1.3 选材（`collect.ts`）：只读归档，但重建一期

**`publish` 绝不重跑 pipeline**——不抓取、不调 LLM、不发推送。但它也不是「直取某一期」，而是按发布线的窗口重建：

```
1. 列窗口内的归档 JSON        （daily: 当天全部；weekly: 周一那期 weekly）
2. 跳过 reprint               isReprint(slot) —— 周报是"重印"，扫日窗口时必须跳过，
                              否则同一条会被算两次（archive/paths.ts 的注释已写明这条）
3. 栏目白名单过滤             include: [tech, ai, cn-tech, security, releases]
4. 跨发布去重                 剔掉 state 里 publishedItemIds 已有的（§4.1）
5. 按 rankScore 降序、截断     maxItems
6. 条数 < minItems ?          → 触发 backfill（往前扩 backfillDays）；仍不够则整体 skip
```

第 2 步能直接复用现成的 [`isReprint`](../src/archive/paths.ts)，第 1 步的窗口扫描与 [`readRecentItems`](../src/archive/read.ts) / [`collectWeekly`](../src/core/weekly.ts) 是同一类遍历——**优先复用，不要另写一个目录遍历**。

跨期去重本身不需要额外工作：pipeline 的跨日 dedupe 保证同一条内容一生只进一期归档，所以合并 `morning`+`evening` 天然不会重复。`publishedItemIds` 要挡的是**另一件事**——backfill 往前扩窗时，可能捞到已经发过的那些期。

这条约束换来三件事：

1. **可任意重跑**——不重复抓取、不重复烧 token、不重复推送；
2. **可补发**——`catchUpDays` 让「昨天 cron 到点时归档还没就绪」自动在今天补上；
3. **与 daily-brief 完全解耦**——早报挂了不影响补发，发布挂了不污染早报的告警。

```
daily-brief.yml ──► archive/*.json ──┬─► publish.yml (cron 09:30) ──► Notion / 掘金
                          │          │        ▲                            │
                          │          │   collect.ts 选材                   │
                          └──► pages.yml ──► 首发地 ◄────────────────────┘ canonical 指回来
```

---

## 2. 配置契约

### 2.1 `publish` 配置块全文

顶层新增，与 `recipients` 平级：

```yaml
publish:
  enabled: true

  # 首发地。适配器用它拼 canonicalUrl 和「本文首发于」。
  # 留空则从 GITHUB_REPOSITORY 推导 https://<owner>.github.io/<repo>/
  canonicalBase: ''

  # ★ 外发栏目白名单（决策 4）。新增栏目默认不外发，这是刻意的。
  include: [tech, ai, cn-tech, security, releases]

  # 发布计划：一条 = 一个固定发布时间 + 一个取材窗口。
  # cron 由 `pnpm publish:schedule` 从这里生成进 publish.yml，改完必须重新生成（§7.2）。
  schedules:
    - id: daily
      time: '09:30' # 本地时间（顶层 timezone），刻意避开整点
      # ★ 级别 1：合并当天两期，把技术条数从 11–17 拉到 23–31（§0.4）
      window: { days: 1, slots: [morning, evening] }
      titleTemplate: '{title} · 技术日报（{date}）'
      tags: [前端, 后端, AI]
      minItems: 8 # 低于此条数当天不发（§8）
      maxItems: 30 # 超过就按 rankScore 截断
      backfillDays: 2 # 条数不够时往前扩几天找未发过的
      catchUpDays: 2 # 归档晚到时，往回补最近几天漏发的
      skipWeekdays: [] # 例如 [mon]：周一只发周报
      enabled: true

    - id: weekly
      time: '10:30'
      weekday: mon
      # 周报直接取 weekly 那期归档 —— 它已经是 weekly.ts 做过编辑取舍的结果，
      # 不要在这里重新聚合一遍七天，那是把同一个判断做两次。
      window: { days: 1, slots: [weekly] }
      titleTemplate: '{title} · 本周技术周报（{range}）'
      tags: [周报, 前端, AI]
      minItems: 12
      maxItems: 40
      backfillDays: 0
      catchUpDays: 3
      enabled: true

  targets:
    - id: notion-archive
      platform: notion
      enabled: true
      schedules: ['*'] # 两条线都要
      secretRef: NOTION_TOKEN
      notion:
        # 二选一。dataSourceRef 优先；两者都留空则报配置错。
        dataSourceRef: NOTION_DATA_SOURCE_ID # 数据库模式（推荐，见 §5.1）
        pageRef: '' # 页面模式：作为子页面挂在某个固定页下
        # 属性名 → 字段。名字必须与 Notion 里的列名逐字一致。
        properties:
          title: Name
          date: Date
          line: Line # 发布线：daily / weekly
          summary: Summary
          tags: Tags
          url: Source
      # Notion 没有草稿态，创建即可见；这个字段对它无意义，写死 true 便于统一。
      autoPublish: true

    - id: juejin
      platform: juejin
      enabled: true
      schedules: [daily, weekly]
      secretRef: JUEJIN_COOKIE
      # 决策 10：试运行期只到草稿箱。转 true 的条件见 §6.5。
      autoPublish: false
      failStreakLimit: 3 # 连续 N 次失败即熔断（§8）
      juejin:
        # 不可猜——一次性从浏览器实抓，见 §6.3。
        categoryId: '6809637767543259144' # 前端
        tagIds: ['6809640407484334093', '6809641083107016712'] # 前端 / 资讯
        syncToOrg: false
      footer: true
      # 某条发布线要换分区/换标签时的逃生口（浅合并，只覆盖列出的键）
      overrides:
        weekly:
          juejin:
            tagIds: ['6809640407484334093'] # 周报只挂一个主标签


    # ---- TODO：抽象验证完再解注释，见 §12 ----
    # - id: devto
    #   platform: devto
    #   enabled: false
    #   schedules: [weekly]
    #   secretRef: DEVTO_API_KEY
```

### 2.2 zod schema（`src/config/schema.ts` 追加）

沿用本仓既有习惯：`secretRef` 只写**变量名**，永不写值；`ID` / `TIME` / `WILDCARD_LIST` 全部复用现成的。

```ts
export const publishScheduleSchema = z.object({
  id: ID,
  time: TIME, // 复用现成的 'HH:MM' 校验
  weekday: z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun']).optional(),
  window: z
    .object({
      days: z.number().int().min(1).max(31).default(1),
      /** 要合并的归档 slot；`null` 表示无 slot 的单排期归档。 */
      slots: z.array(z.string().min(1)).min(1),
    })
    .default({ days: 1, slots: ['morning'] }),
  titleTemplate: z.string().min(1).default('{title} · {date}'),
  tags: z.array(z.string().min(1)).default([]),
  minItems: z.number().int().min(0).max(200).default(8),
  maxItems: z.number().int().min(1).max(200).default(30),
  backfillDays: z.number().int().min(0).max(30).default(0),
  catchUpDays: z.number().int().min(0).max(30).default(2),
  skipWeekdays: z.array(z.enum(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).default([]),
  enabled: z.boolean().default(true),
})

export const publishTargetSchema = z.object({
  id: ID,
  platform: z.enum(['notion', 'juejin', 'stdout']),
  enabled: z.boolean().default(true),
  schedules: WILDCARD_LIST.default(['*']),
  secretRef: z.string().min(1),
  autoPublish: z.boolean().default(false),
  failStreakLimit: z.number().int().min(1).max(20).default(3),
  footer: z.boolean().default(true),
  notion: z
    .object({
      dataSourceRef: z.string().default(''),
      pageRef: z.string().default(''),
      properties: z
        .object({
          title: z.string().default('Name'),
          date: z.string().default('Date'),
          line: z.string().default('Line'),
          summary: z.string().default('Summary'),
          tags: z.string().default('Tags'),
          url: z.string().default('Source'),
        })
        .default({}),
    })
    .optional(),
  juejin: z
    .object({
      categoryId: z.string().min(1),
      tagIds: z.array(z.string().min(1)).min(1).max(3), // 掘金最多 3 个标签
      syncToOrg: z.boolean().default(false),
    })
    .optional(),
  /** 发布线 id → 该发布线上的浅合并覆盖。 */
  overrides: z.record(z.unknown()).default({}),
})

export const publishSchema = z
  .object({
    enabled: z.boolean().default(false),
    canonicalBase: z.string().default(''),
    include: z.array(z.string().min(1)).min(1),
    schedules: z.array(publishScheduleSchema).default([]),
    targets: z.array(publishTargetSchema).default([]),
  })
  .default({})
```

`superRefine` 里追加五条校验（与现有 `flagDupes` 同一处）：

1. `publish.schedules[].id` 与 `publish.targets[].id` 各自不得重复；
2. `publish.include` 里的每个 id 必须是**真实存在的 section**——写错一个字就静默少发一整栏，这种错误绝不能等到线上才发现；
3. `targets[].schedules` 里的非通配 id 必须存在于 `publish.schedules`；
4. `platform: notion` 必须有 `notion` 块，且 `dataSourceRef` 与 `pageRef` **恰好有一个**非空；
5. `platform: juejin` 必须有 `juejin` 块（`categoryId` / `tagIds` 无默认值——猜错会发到错误分区，宁可启动即报错）。

> 第 2 条尤其值钱：`include` 是本方案里**唯一一个「配错了不报错、只是内容变少」**的字段。

### 2.3 CLI

`src/publish.ts`，参数风格对齐 [`src/cli.ts`](../src/cli.ts)：

| 参数              | 含义                                                                  |
| ----------------- | --------------------------------------------------------------------- |
| `--schedule <id>` | 跑哪条发布线（`daily` / `weekly`），默认 `daily`                      |
| `--cron <expr>`   | GitHub 报的是哪个 cron 触发，反查发布线 id——与 daily-brief.yml 同一套 |
| `--date <d>`      | 发布日 `YYYY-MM-DD`，默认今天（决定取材窗口的右端）                   |
| `--targets <ids>` | 逗号分隔，覆盖配置里的启用集合                                        |
| `--catch-up <n>`  | 覆盖 `catchUpDays`；`0` 表示只跑今天                                  |
| `--dry-run`       | 选材 + 渲染并打印，不调任何平台接口，不写状态                         |
| `--force`         | 忽略 `contentHash` 相同的 skip 判定，强制 update                      |
| `--publish`       | 本次允许执行 `publish()`（等价临时打开 `autoPublish`）                |
| `--no-commit`     | 不写 `*.publish.json`（配合 `--dry-run` 调试）                        |
| `--explain`       | 只打印选材过程：每期贡献几条、被白名单挡掉几条、去重掉几条、最终几条  |
| `--validate-only` | 只校验配置与 secret 齐备性，立即退出                                  |

`--explain` 不是锦上添花：`collect.ts` 是本方案里唯一「结果对不对只能靠肉眼判断」的一环，没有它，「今天怎么只发了 9 条」这种问题只能靠加日志重跑。

### 2.4 环境变量

| 变量                     | 来源   | 必需           | 说明                                    |
| ------------------------ | ------ | -------------- | --------------------------------------- |
| `NOTION_TOKEN`           | secret | 启用 notion 时 | Integration Token                       |
| `NOTION_DATA_SOURCE_ID`  | secret | 数据库模式     | 见 §5.1；填数据库 ID 也能用，会自动解析 |
| `NOTION_PAGE_ID`         | secret | 页面模式       | 与上者二选一                            |
| `JUEJIN_COOKIE`          | secret | 启用 juejin 时 | 完整 Cookie 串，至少含 `sessionid`      |
| `PUBLISH_ENABLED`        | vars   | 否             | `false` 等价于全局熔断，不改配置就停发  |
| `PUBLISH_CANONICAL_BASE` | vars   | 否             | 覆盖 `canonicalBase`，换域名时用        |

`PUBLISH_ENABLED` 是刻意抄 `LLM_ENABLED` 的：**破窗开关必须是 repo variable，不能是配置文件**——出事时你要能在手机上点两下就停，而不是发一个 PR。

---

## 3. 内容适配层（`adapt.ts`）

### 3.1 归档那份 markdown 不能直接发

三个具体原因，每个都会在真实平台上肉眼可见地炸掉：

1. **转义**。[`renderArchiveMarkdown`](../src/render/markdown.ts) 全程走 `escapeMarkdown()`，把 `` ` `` `[` `]` `<` `>` `_` `*` `\` 都转成 `\[` 这种形式。掘金编辑器会把反斜杠**原样显示**，Notion 转 block 时同样会带进去。
2. **运行元数据**。`- 生成时间：…` / `- 时段：morning（回溯 24 小时…）` / `## 告警` 这三块是给运维看的，不是给读者看的，必须剥掉。
3. **缺字段**。没有列表页摘要（掘金 `brief_content`）、没有封面、相对链接没绝对化。

而且发布的内容是 `collect.ts` 重建出来的，**本来就不存在一份现成的归档 markdown 可以直取**——`adapt.ts` 是从 `CollectedIssue` 重新渲染的。

### 3.2 唯一需要改动现有渲染层的地方

把 `escapeMarkdown` 从写死改成可注入，默认值不变——**对现有调用点完全向后兼容**：

```ts
export interface RenderOptions {
  detail?: Detail
  compactMaxChars?: number
  digestTitle?: string
  digestPosition?: 'top' | 'bottom'
  /** 平台方言渲染时传 `(s) => s`：掘金/Notion 都不需要邮件那套反斜杠转义。 */
  escape?: (text: string) => string
}
```

`renderItemMarkdown` / `renderArchiveMarkdown` 内部把裸调用换成 `const esc = options.escape ?? escapeMarkdown`。这一改动必须配一条回归单测：**不传 `escape` 时输出与改动前逐字节相同**。

### 3.3 字段推导规则

| 字段           | 来源                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------- |
| `title`        | 发布线的 `titleTemplate`；`{title}`=配置 title，`{date}`=发布日，`{range}`=窗口区间           |
| `brief`        | 取窗口内**最新一期**的导读 `digest.text`——它天生就是三句话摘要，正好是这个用途                |
| `markdown`     | 用 `escape: (s) => s` 渲染 `CollectedIssue`，再做 §3.1 的三步清洗                             |
| `tags`         | 发布线的 `tags`；被 `targets[].overrides.<line>` 浅合并覆盖                                   |
| `canonicalUrl` | 窗口内**最新一期**在 Pages 上的页面 URL，与 [site/build](../src/site/build.ts) 的产物路径一致 |
| `coverUrl`     | 本期不做，留空                                                                                |

**关于 canonical 的诚实性**：日报文章是当天两期合并 + 只留技术，所以 Pages 上没有一个页面与它逐条对应。处理是——canonical 指向窗口内最新一期（最接近的首发载体），而 footer **把取材的每一期都列出来**（§3.4）。读者点得到，来源也说得清。

无 `digest`（M3 之前的归档、或那次 LLM 挂了）时，`brief` 降级为「前 N 条标题拼接，截到 100 字」。**降级路径必须有单测**——这是本仓一贯的要求。

### 3.4 强制 footer

`footer: true` 时，正文尾部追加：

```markdown
---

> 本文由 [daily-brief](repoUrl) 自动整理，只收录技术条目（新闻栏不外发）。
> 取材：[2026-08-25 早报](…/2026/08/2026-08-25.html) · [2026-08-25 晚报](…/2026/08/2026-08-25.evening.html)
> 完整归档（含未收录栏目）：<indexUrl>
```

**这不是礼貌，是保命。** 一文多发不写来源，在掘金极易被判搬运；写清「自动整理 + 取材期 + 完整归档」，则它是一篇**有明确编辑口径的整理稿**——「只收录技术条目」这句话本身就在说明这不是原样搬运。

---

## 4. 幂等与状态机

### 4.1 状态文件

文章不再一一对应某期归档（§1.3），所以状态的主键换成 **发布日 + 发布线**：

```
archive/2026/08/2026-08-25.json          # 早报内容（已有）
archive/2026/08/2026-08-25.evening.json  # 晚报内容（已有）
archive/2026/08/2026-08-25.publish.json  # ★ 当天所有发布线的状态（新增）
```

```jsonc
{
  "publishDate": "2026-08-25",
  "lines": {
    "daily": {
      "sources": [
        { "date": "2026-08-25", "slot": null },
        { "date": "2026-08-25", "slot": "evening" },
      ],
      "itemCount": 27,
      // ★ 跨发布去重的唯一依据：backfill 往前扩窗时不会重复捞到这些
      "itemIds": ["hn-41234567", "rss-a1b2c3", "…"],
      "contentHash": "b7a1…",
      "targets": {
        "notion-archive": {
          "platform": "notion",
          "status": "published",
          "postId": "1f2c3d4e-…",
          "url": "https://www.notion.so/1f2c3d4e…",
          "contentHash": "b7a1…",
          "attempts": 1,
          "failStreak": 0,
          "updatedAt": "2026-08-25T01:30:11Z",
        },
        "juejin": {
          "platform": "juejin",
          "status": "draft",
          "postId": "7541234567890123456",
          "url": "https://juejin.cn/editor/drafts/7541234567890123456",
          "contentHash": "b7a1…",
          "attempts": 1,
          "failStreak": 0,
          "updatedAt": "2026-08-25T01:30:19Z",
          "lastError": null,
        },
      },
    },
  },
}
```

两处细节：

- **`itemIds` 存的是 id，不是整条 item**——内容已经在归档 JSON 里了，这里再存一份就是两个真相。
- 写入前必须过 [`redactDeep`](../src/core/redact.ts)——`lastError` 里可能带着掘金返回的部分 Cookie 或 URL 参数，**而这个仓库是公开的**。这条与 A16 是同一条规则。

### 4.2 判定表（`state.ts` 的 `decide()`，纯函数）

| 已有状态                        | `contentHash` | 动作               | 理由                                       |
| ------------------------------- | ------------- | ------------------ | ------------------------------------------ |
| 无记录                          | —             | `createDraft`      | 首次                                       |
| `draft` / `created`             | 相同          | **skip**           | 重跑安全——整个方案的地基                   |
| `draft` / `created`             | 不同          | `updateDraft`      | 选材变了（比如补发把新条目并了进来）       |
| `published`（notion）           | 不同          | `updateDraft`      | 归档镜像，语义就是「保持同步」             |
| `published`（juejin）           | 不同          | **skip + warning** | 已经在公开时间线上，不静默改；要改人工去改 |
| `failed`，`failStreak < limit`  | 任意          | 重试上一步         | 多半是网络或限流                           |
| `failed`，`failStreak >= limit` | 任意          | **熔断 + 告警**    | 在风控里反复撞墙只会更糟（§8）             |
| 选材条数 `< minItems`           | —             | **整线 skip**      | 宁可缺一期，也不发凑数文（决策 11）        |
| 发布线 `skipWeekdays` 命中今天  | —             | **整线 skip**      | 例如周一只发周报                           |
| 任意                            | 任意          | `--force` 覆盖以上 | 只有手工触发才可能带这个参数               |

### 4.3 `contentHash` 的定义

```ts
sha256(`${article.title}\n${article.brief}\n${article.markdown}`).slice(0, 16)
```

**只哈希会真正影响读者所见的三个字段。** 不含 `generatedAt`、不含 `configHash`、不含 `tags`——否则改一次标签就要重发全站，而且每次重跑都因为时间戳不同而判定「内容变了」，幂等直接失效。

---

## 5. Notion 适配器（Tier 1）

### 5.1 认证与父级：先解决 2025-09-03 那个断裂

Notion 在 API 版本 `2025-09-03` 把「数据库」拆成了 **database（容器）→ data source（数据源）→ page（行）**。**在数据库下建页面的 `parent` 从 `database_id` 变成了 `data_source_id`**，这是破坏性变更。

本方案的处理：

- 请求头固定 `Notion-Version: 2025-09-03`（不追随 latest，版本升级必须是一次显式改动）；
- 配置里的 `NOTION_DATA_SOURCE_ID` **允许填数据库 ID**：适配器若发现该 ID 不是 data source，就调 `GET /v1/databases/{id}` 取 `data_sources[0].id`，并在日志里打印一行「已解析 database → data_source」。**这一步只在 `missingEnv` 之后、第一次写之前做一次**，不进每篇文章的热路径；
- 另提供 `pageRef` 模式：`parent: { page_id }`，把每期作为子页面挂在一个固定页下。**这条路完全绕开 data source 的演进**，是「只想要个归档、不需要属性检索」时的正解。

| 端点                             | 用途                                  |
| -------------------------------- | ------------------------------------- |
| `GET /v1/databases/{id}`         | database → data_source 解析（仅一次） |
| `POST /v1/pages`                 | 建页（属性 + 前 100 个 block）        |
| `PATCH /v1/blocks/{id}/children` | 追加剩余 block，每次 ≤100             |
| `GET /v1/blocks/{id}/children`   | update 时先列出旧 block               |
| `DELETE /v1/blocks/{id}`         | update 时逐个删旧 block（见 §5.3）    |
| `PATCH /v1/pages/{id}`           | 更新属性                              |

### 5.2 markdown → blocks：这是 Notion 这一路的全部工作量

**Notion API 不吃 markdown。** 必须自己转成 block 对象数组，且要顶住这几条硬限额：

| 限额                       | 值      | 后果                                          |
| -------------------------- | ------- | --------------------------------------------- |
| 单次请求 `children` 元素数 | ≤ 100   | 一篇 30 条的日报 → 必须**分批 append**        |
| 单个 rich text 的 content  | ≤ 2000  | 长摘要要切成多个 rich text 对象拼在同一 block |
| 单次请求 block 总数        | ≤ 1000  | 分批后天然不会碰到                            |
| 单次请求体积               | ≤ 500KB | 同上                                          |
| 单次请求嵌套深度           | ≤ 2 层  | 只用扁平结构即可规避                          |

> 条数上去之后这条更要紧：30 条 × （标题 + 摘要 + 3 条 takeaway）很容易冲到 150+ block，**必然要分批**。M2 的分批边界测试不是可选项。

`src/publish/markdown.ts` 只需要支持归档 markdown 实际会产出的**六种结构**，不做通用 markdown 解析器：

| markdown         | Notion block                                   |
| ---------------- | ---------------------------------------------- |
| `# / ## / ###`   | `heading_1 / heading_2 / heading_3`            |
| `1. [标题](url)` | `numbered_list_item` + rich text 带 `link.url` |
| `- 文本`         | `bulleted_list_item`                           |
| `> 引用`（导读） | `quote`                                        |
| `---`            | `divider`                                      |
| 其余             | `paragraph`                                    |

**刻意不支持**代码块、表格、图片——归档 markdown 里不会出现，写了就是死代码。真出现了就落到 `paragraph`，丑但不崩。

分批策略：

```
POST /v1/pages             ← 属性 + children[0..99]
PATCH blocks/{id}/children ← children[100..199]
PATCH blocks/{id}/children ← …（串行，不并发：Notion 有约 3 req/s 的速率约束）
```

### 5.3 update 的现实：Notion 没有「整页替换」

要覆盖一页内容，只能 `GET children` → 逐个 `DELETE` → 重新 append。一篇 30 条的日报是一百多次 DELETE，串行下来半分钟起。

**决定：M2 的 update 只更新页面属性，正文不动，并在 `detail` 里写明「正文未同步，内容已变更」。** 正文全量重写留到 M5，且必须 `--force` 显式触发。理由：Notion 是私人归档镜像，正文差几条不影响它的用途，而上百次 DELETE 中途失败会留下**半页内容**，比不更新糟得多。

### 5.4 属性映射

| Notion 属性（可配名） | 类型         | 值                                   |
| --------------------- | ------------ | ------------------------------------ |
| `Name`                | title        | `article.title`                      |
| `Date`                | date         | `article.publishDate`                |
| `Line`                | select       | `article.scheduleId`（daily/weekly） |
| `Summary`             | rich_text    | `article.brief`（≤2000）             |
| `Tags`                | multi_select | `article.tags`                       |
| `Source`              | url          | `article.canonicalUrl`               |

属性名不匹配时 Notion 报 `validation_error`。适配器要把这个错误**原样透出到 `detail`**，别包装——「Summary is not a property that exists」这句话本身就是最好的修复指引。

---

## 6. 掘金适配器（Tier 2）

### 6.1 先把话说清楚

**掘金没有官方开放发布 API。** 这里用的是网页端自己在调的接口，靠浏览器登录态认证。这意味着：

- 接口可能在任何一天变，**没有兼容承诺，也没有公告**；
- Cookie 会过期（`sessionid` 量级约 30 天），到期即全线失败；
- 从 GitHub 的境外 runner 发请求，可能触发异地登录风控；
- 极端情况下账号有被限制的风险，**这个成本由使用者承担**。

社区成熟工具（[Wechatsync](https://github.com/wechatsync/Wechatsync) 走浏览器扩展复用 Cookie、[ArtiPub](https://www.oschina.net/news/131216/artipub-0-1-5-released) 走 Puppeteer 注入 Cookie）都跑在**用户本机或自建服务器**上，而不是公有 CI 上——这个差异不是偶然。本方案是知情地接受它，并用 §6.5 的分阶段策略把爆炸半径压到最小。

### 6.2 接口序列

| 步骤   | 端点                                                             | 关键参数                                                                                           |
| ------ | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| 建草稿 | `POST https://api.juejin.cn/content_api/v1/article_draft/create` | `title` / `mark_content` / `edit_type: 10`(markdown) / `brief_content` / `category_id` / `tag_ids` |
| 改草稿 | `POST .../article_draft/update`                                  | 同上 + `id`（草稿 id）                                                                             |
| 发布   | `POST .../article/publish`                                       | `draft_id`（**仅 `autoPublish: true` 时调用**）                                                    |

公共要求：

- Header：`Cookie: <JUEJIN_COOKIE>`、`content-type: application/json`、一个正常的 `User-Agent`、`Referer: https://juejin.cn/`；
- 返回体是 `{ err_no, err_msg, data }` 形态——HTTP 200 不代表成功。**这正是现成的 [`assertOkCode()`](../src/channels/types.ts) 在做的事**，改个字段名即可复用，`err_no !== 0` 即抛错；
- 拿到的 `data.id` 是草稿 id，用它拼 `https://juejin.cn/editor/drafts/{id}` 写进状态文件，**你点开就能审阅**。

> 端点路径与字段名以浏览器实抓为准（§6.3）。适配器里这些字符串必须集中在文件顶部的一个常量块，接口一变只改一处。

### 6.3 `category_id` / `tag_ids` 怎么拿

**不要猜，也不要从任何文章里抄。** 一次性实抓，抄进配置并写上中文注释：

1. 浏览器登录掘金，打开写文章页，正常填一篇测试文，选好分类和标签；
2. F12 → Network，筛 `article_draft`；
3. 点「保存草稿」，看那次请求的 request payload；
4. 把 `category_id` 和 `tag_ids` 抄进 `brief.config.yaml`，**注释里写上它们对应的中文名**——半年后没人记得 `6809637767543259144` 是「前端」。

顺手把这次请求的完整 Cookie 抄下来存 `JUEJIN_COOKIE`。**Cookie 含账号凭证，只进 GitHub Secrets，绝不进配置文件、日志或 `*.publish.json`。**

掘金标签**最多 3 个**，schema 里已经用 `.max(3)` 卡住（§2.2）——超了是接口报错，不如启动就报。

### 6.4 掘金 markdown 方言

| 现象                         | 处理                                               |
| ---------------------------- | -------------------------------------------------- |
| 反斜杠转义原样显示           | `escape: (s) => s`，见 §3.2                        |
| 相对链接不解析               | adapt 阶段全部绝对化到 Pages 域名                  |
| 首个 `# 标题` 与文章标题重复 | 剥掉正文第一个 h1——标题已经在 `title` 字段里       |
| `brief_content` 有长度约束   | 截到 100 字，用现成的 `truncate()`（按句子边界切） |
| 纯外链列表观感像营销号       | 导读放最前 + footer 写明编辑口径（§3.3、§3.4）     |

### 6.5 掘金分两阶段：试运行期草稿，稳定后转自动

每天一篇的节奏下，「永远人工点发布」不现实——那是把一个自动化流程变成一个每日待办。所以分两段：

**阶段 A · 试运行（`autoPublish: false`）**

- 只到草稿箱；你每天在草稿箱里看一眼，确认格式、条数、选材没问题；
- 同时打开 `environment: publishing` 的人工批准（§7.4）；
- **退出条件：连续 10 期（约两周）格式无异常、条数稳定在 `minItems` 以上、Cookie 没掉过。**

**阶段 B · 自动（`autoPublish: true`）**

- 关掉人工批准，改为「失败即告警 + 连续失败即熔断」；
- 掘金那一路的 `failStreakLimit: 3` 起作用：连续三次失败就停下等人，不再撞墙；
- `PUBLISH_ENABLED=false` 是随时可用的一键停发（§2.4）。

不要跳过阶段 A 直接进 B。**markdown 方言的坑只有在真实编辑器里看过才知道**，而阶段 A 的成本只是每天瞄一眼草稿箱。

---

## 7. Workflow 编排

### 7.1 方案对比

| 方案 | 做法                                | 判断                                                                                                                           |
| ---- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1    | 在 `daily-brief.yml` 末尾加 step    | ✗ 发布失败会把早报 job 染红并触发 [`alert.ts`](../src/alert.ts) 误报；Cookie 进入早报 job 的环境；且发布时刻被钉死在生成时刻上 |
| 2    | 独立 `publish.yml` + `workflow_run` | ✗ **本次否决**。发布时刻 = 早报跑完那一刻，会跟着 Actions 排队漂 0–30 分钟——与「每天固定时间发布」直接冲突                     |
| 3    | **独立 `publish.yml` + 自持 cron**  | ★ 采用。发布时间由自己说了算；代价是要处理「归档还没就绪」，用 `catchUpDays` 解（§1.3）                                        |
| 4    | 外部 cron 打 `repository_dispatch`  | ✗ 过度设计。GitHub cron 的 0–30 分钟漂移，对「09:30 发一篇技术日报」这件事完全无所谓                                           |

**为什么不把 `workflow_run` 留着当兜底**：幂等机制（§4）确实能保证它不会造成重复发布，但它会让「今天这篇几点发的」变得不可预测——而这正是需求 1 要的东西。漏发由 `catchUpDays` 覆盖，不需要第二个触发器。

### 7.2 cron 从配置生成，并进漂移守卫

`publish.yml` 的 cron 块**不手写**，与 `daily-brief.yml` 用同一套生成器 [`src/schedule/`](../src/schedule/cron.ts)：

- `generateCrons()` 现在读的是 `config.schedules`，抽出一个参数化版本，让它也能读 `config.publish.schedules`（`weekday` 字段正好命中现成的 [`weeklyToUtcCron`](../src/schedule/cron.ts)）；
- `generate.ts` 已经支持 `--workflow <path>`，再加一个 `--kind brief|publish` 选哪个来源；
- `pnpm check:schedule` 扩成**同时校验两个 workflow**，继续跑在 CI 里。

这条不是洁癖。A17 那条守卫的存在理由是「改了时间忘了重新生成 → 时间没变且毫无提示」；现在有两个 workflow、四个 cron，忘记的概率翻倍。

生成结果长这样：

```yaml
on:
  schedule:
    # BEGIN generated schedule
    # generated from brief.config.yaml — run `pnpm publish:schedule` after editing, do not hand-edit
    - cron: '30 1 * * *' # daily - 09:30 Asia/Shanghai
    - cron: '30 2 * * 1' # weekly - Mon 10:30 Asia/Shanghai
    # END generated schedule
```

### 7.3 `.github/workflows/publish.yml`

```yaml
name: publish

on:
  schedule:
    # BEGIN generated schedule
    # generated from brief.config.yaml — run `pnpm publish:schedule` after editing, do not hand-edit
    - cron: '30 1 * * *' # daily - 09:30 Asia/Shanghai
    - cron: '30 2 * * 1' # weekly - Mon 10:30 Asia/Shanghai
    # END generated schedule

  workflow_dispatch:
    inputs:
      schedule:
        description: 发布线 id（daily / weekly）
        type: string
        default: daily
      date:
        description: 'YYYY-MM-DD 发布日（留空=今天）'
        type: string
        default: ''
      targets:
        description: 逗号分隔的 target id（留空=配置里所有启用项）
        type: string
        default: ''
      dry-run:
        description: 只选材+渲染，不调平台接口（手工触发时的安全默认）
        type: boolean
        default: true
      force:
        description: 忽略 contentHash 判定，强制重发
        type: boolean
        default: false
      publish:
        description: 允许执行真正的「发布」而不止于草稿
        type: boolean
        default: false

# 串行，且绝不 cancel：半个发布比晚一点的发布糟得多（与 daily-brief 同一条理由）。
# 周一两条线相隔一小时，本来也不会撞上；这里是防手工触发插队。
concurrency:
  group: publish
  cancel-in-progress: false

permissions:
  contents: write # 仅为写回 *.publish.json

jobs:
  publish:
    runs-on: ubuntu-latest
    timeout-minutes: 15 # 比 daily-brief 宽：Notion 的分批 append 是串行的

    steps:
      # 必须取 main 的最新状态：早报的归档提交刚落在 main 上，而 cron 事件的
      # github.sha 未必包含它。fetch-depth 1 足够 —— 选材读的是文件，不是 git 历史。
      - uses: actions/checkout@v4
        with:
          ref: main
          fetch-depth: 1

      - uses: pnpm/action-setup@v4
        with:
          version: 10

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm

      - run: pnpm install --frozen-lockfile

      # 两个 workflow 的 cron 都必须与 brief.config.yaml 一致（§7.2）。
      - name: check schedule drift
        run: pnpm check:schedule

      - name: publish
        id: publish
        env:
          NOTION_TOKEN: ${{ secrets.NOTION_TOKEN }}
          NOTION_DATA_SOURCE_ID: ${{ secrets.NOTION_DATA_SOURCE_ID }}
          NOTION_PAGE_ID: ${{ secrets.NOTION_PAGE_ID }}
          JUEJIN_COOKIE: ${{ secrets.JUEJIN_COOKIE }}
          PUBLISH_ENABLED: ${{ vars.PUBLISH_ENABLED }}
          PUBLISH_CANONICAL_BASE: ${{ vars.PUBLISH_CANONICAL_BASE }}
        run: |
          set -euo pipefail
          args=()
          if [ -n "${{ github.event.schedule }}" ]; then
            # GitHub 报的是哪个 cron 触发；CLI 反查发布线 id —— 与 daily-brief.yml 同一套。
            args+=(--cron "${{ github.event.schedule }}")
          else
            args+=(--schedule "${{ inputs.schedule || 'daily' }}")
          fi
          [ -n "${{ inputs.date }}" ]    && args+=(--date "${{ inputs.date }}")
          [ -n "${{ inputs.targets }}" ] && args+=(--targets "${{ inputs.targets }}")
          [ "${{ inputs.dry-run }}" = "true" ] && args+=(--dry-run)
          [ "${{ inputs.force }}"   = "true" ] && args+=(--force)
          [ "${{ inputs.publish }}" = "true" ] && args+=(--publish)
          pnpm publish:run "${args[@]}"

      # 与 daily-brief 同构：状态已经产生，不能因为后续失败而丢。
      - name: commit publish state
        if: always() && steps.publish.outputs.state-commit == 'true'
        run: |
          set -euo pipefail
          git add 'archive/**/*.publish.json'
          if git diff --cached --quiet; then
            echo "publish state unchanged, nothing to commit"
            exit 0
          fi
          git -c user.name='github-actions[bot]' \
              -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
              commit -m "chore(publish): ${{ steps.publish.outputs.state-label }}"
          for attempt in 1 2 3; do
            if git pull --rebase --autostash && git push; then
              echo "pushed on attempt $attempt"
              exit 0
            fi
            echo "push attempt $attempt failed, retrying"
            sleep $((attempt * 5))
          done
          echo "could not push the publish state after 3 attempts" >&2
          exit 1

      - name: alert on failure
        if: failure()
        env:
          WECOM_WEBHOOK_ME: ${{ secrets.WECOM_WEBHOOK_ME }}
          SMTP_HOST: ${{ secrets.SMTP_HOST }}
          SMTP_PORT: ${{ secrets.SMTP_PORT }}
          SMTP_USER: ${{ secrets.SMTP_USER }}
          SMTP_PASS: ${{ secrets.SMTP_PASS }}
          EMAIL_FROM: ${{ secrets.EMAIL_FROM }}
          ALERT_REASON: 'publish 失败 —— 多半是掘金 Cookie 过期，去续；详情见 run'
        run: pnpm tsx src/alert.ts
```

### 7.4 人工闸门只在试运行期

`environment: publishing` + Settings → Environments → Required reviewers 勾上自己，job 会挂起等你在 GitHub App 里点 Approve。

**这只适合 §6.5 的阶段 A。** 每天一篇的节奏下长期开着，等于把自动化退化成每日待办；而一旦你开始无脑点 Approve，它提供的保护也就没了。

阶段 B 的替代物是三层，全部是被动的：

1. `minItems` 闸门——内容不够就不发（§4.2）；
2. `failStreakLimit` 熔断——连续失败就停（§8）；
3. `PUBLISH_ENABLED=false`——手机上两下停发（§2.4）。

### 7.5 为什么不用 matrix

`strategy.matrix.platform: [notion, juejin]` 看起来很自然，但每个 job 都要**写同一个 `*.publish.json` 再 push**，必然互相踩。要么加锁，要么合并——两条路都比「一个 job 里 `Promise.all`」复杂。

而 `Promise.all` + 每目标独立 try/catch 正是 [`deliver()`](../src/channels/index.ts) 已经验证过的形状：**一个平台挂了不影响另一个**，这正是 matrix 想要的隔离性，而且不用为它引入并发写文件的问题。

---

## 8. 失败与告警

| 情况                  | 表现                        | 处理                                                                   |
| --------------------- | --------------------------- | ---------------------------------------------------------------------- |
| 缺 secret             | `missingEnv` 非空           | **skip**，写进 summary，`exitCode` 不变（决策 8）                      |
| **归档还没就绪**      | 窗口内一期都没有            | **skip + warning，exit 0**——cron 早到不是故障，明天 `catchUpDays` 补上 |
| **条数 < `minItems`** | 选材后不足                  | **整线 skip + warning**，并在 summary 里打印 `--explain` 那张表        |
| Notion 属性名不匹配   | `validation_error`          | `failed`，原样透出错误文本                                             |
| Notion 限流           | HTTP 429                    | 指数退避重试 ×3（复用 llm 那套退避逻辑）                               |
| 掘金 `err_no !== 0`   | HTTP 200 但业务码非 0       | `failed`，`err_msg` 写进 `lastError`（**先 redact**）                  |
| **掘金 Cookie 过期**  | 401 / 业务码非 0 / 跳登录页 | `failed` + 告警文案直接写「Cookie 已过期，去续」                       |
| 掘金触发风控          | 异常业务码或要求验证        | `failed` + 告警；`failStreak` 累加                                     |
| **连续失败到上限**    | `failStreak >= limit`       | **熔断**：不再尝试，告警写「已熔断，修好后 `--force` 重跑」            |
| 部分平台成功          | —                           | 成功的照常写状态，失败的记 `failStreak`，job 非 0 退出触发告警         |

告警复用现成的 [`src/alert.ts`](../src/alert.ts)（企业微信 + 邮件），**不新增通道**。关键是文案要能一眼看出该做什么——「掘金 Cookie 已过期」比「publish 失败」有用一百倍。

**「归档未就绪」为什么是 exit 0**：每天 09:30 的 cron 撞上一次 Actions 排队，就会误报一次。如果它是 failure，你一周会收到两三条假告警，然后就开始无视告警——那才是真正的故障。

---

## 9. 测试策略

对齐本仓既有做法：**所有网络调用走注入的 `fetchImpl`，单测永不联网。**

| 模块          | 必测                                                                                                                                                                                                                             |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `collect.ts`  | ★ 白名单只放行 `include` 里的栏目（**新闻栏一条都不能漏**）；`morning`+`evening` 合并；`isReprint` 的 weekly 被跳过；`publishedItemIds` 去重；`maxItems` 按 rankScore 截断；`minItems` 不足触发 backfill；backfill 仍不足则 skip |
| `state.ts`    | §4.2 判定表**逐行**；`failStreak` 累加与熔断；`--force` 覆盖；损坏的 state 文件按「无记录」处理而不是崩                                                                                                                          |
| `adapt.ts`    | 转义确实关掉了；元数据/告警段确实剥了；相对链接绝对化；**无 `digest` 时的 brief 降级**；footer 列出全部取材期                                                                                                                    |
| `markdown.ts` | 六种结构各一例；**>100 block 时的分批边界**（99/100/101 三个用例）；单段 >2000 字的 rich text 切分                                                                                                                               |
| `notion.ts`   | 假 fetch 断言请求序列与 payload；database→data_source 解析只发生一次；属性错误原样透出                                                                                                                                           |
| `juejin.ts`   | 断言 `edit_type: 10`；`err_no !== 0` 抛错；**`autoPublish: false` 时绝不调 `article/publish`**（这条最重要）；Cookie 不出现在任何抛出的错误里                                                                                    |
| `index.ts`    | 一个 target 抛错不影响另一个；缺 env 是 skip 不是 fail；`targets[].schedules` 通配与精确匹配                                                                                                                                     |
| cron 生成器   | `publish.schedules` 生成的 cron 与手写期望一致；`weekday` 走 `weeklyToUtcCron`；`check:schedule` 对两个 workflow 都能报漂移                                                                                                      |
| schema        | `include` 里写了不存在的 section → 配置校验直接失败（§2.2 第 2 条）                                                                                                                                                              |
| 回归          | `render/markdown.ts` 不传 `escape` 时输出与改动前**逐字节相同**                                                                                                                                                                  |

两条「防止不可逆后果」的测试，必须写在对应里程碑的第一个 commit 里：

- `collect.ts` 的**新闻栏零放行**——发错内容比不发糟得多；
- `juejin.ts` 的 **`autoPublish: false` 绝不调 publish**。

---

## 10. 里程碑

| 里程碑                 | 内容                                                                                | 验收（每条都可执行）                                                                                                                                                                                                                                                                                           |
| ---------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M1 骨架 + 选材**     | `types` / `index` / `state` / `stdout` / `collect` / `adapt` + config schema + CLI  | ① `pnpm publish:run --schedule daily --dry-run --explain` 打印选材过程，**技术条数 ≥20 且新闻栏 0 条**；② 打印的正文肉眼无 `\[`、无「生成时间」、无「告警」段；③ `pnpm test` 覆盖 §4.2 全表 + `collect` 全部用例；④ typecheck/lint 全绿；⑤ 渲染回归逐字节未变                                                  |
| **M2 Notion**          | `markdown.ts` + `notion.ts` + data source 解析                                      | ① 手工 `--targets notion-archive` 跑一次，Notion 库里出现该期，属性齐全、**30 条正文完整分批写入**；② **再跑一次 → `skipped`，库里没有第二条**；③ 改一个字后跑 → 属性更新且 detail 写明正文未同步                                                                                                              |
| **M3 cron + 掘金草稿** | `juejin.ts`（只 create/update）+ cron 生成器扩展 + `publish.yml` + 试运行期闸门     | ① `pnpm publish:schedule --write` 生成的 cron 与配置一致，`pnpm check:schedule` 对两个 workflow 都通过；② 09:30 自动触发，掘金草稿箱出现文章，**打开编辑器格式无异常**；③ 重跑 → `skipped`，草稿箱没有第二篇；④ 错 Cookie → 企业微信收到「Cookie 已过期」；⑤ 删掉当天归档跑一次 → skip + warning 且 **exit 0** |
| **M4 观察期（两周）**  | 不写代码：每天看草稿箱 + 收集条数样本                                               | ① 连续 10 期格式无异常；② 记录每期真实技术条数——**若中位数 <20，才启动 §0.4 级别 2（提 limit + `maxItemsPerSection`）**；③ Cookie 未失效                                                                                                                                                                       |
| **M5 转自动 + 收口**   | 掘金 `autoPublish: true` + 熔断生效 + Notion 正文全量重写（`--force`）+ README 补章 | ① 关掉人工批准后连续 5 期自动发布成功；② 人为造三次失败 → 熔断并告警，第四次不再请求；③ `--force` 能把 Notion 一页正文完整重写；④ README 有「配置发布目标」小节                                                                                                                                                |

**M1 是唯一不可跳的一步**：`collect.ts` 的选材和 §4 的幂等如果没先立住，M2/M3 就是在三个不确定性上同时调试。
**M4 也不能跳**：条数够不够、格式炸不炸，是**只能测量、不能推断**的两件事。

---

## 11. 风险与对冲

| 风险                           | 影响                   | 对冲                                                                                                                                       |
| ------------------------------ | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **新闻条目漏进外发**           | 内容跑偏，编辑口径失守 | 白名单而非黑名单（决策 4）；`include` 里的 id 在配置校验期就要求真实存在；`collect.ts` 有一条专测「新闻栏零放行」                          |
| **移除新闻后条数不够**         | 文章干瘪               | 级别 1 合并两期（实测 23–31 条）；`minItems` 兜底不发；M4 用真实样本决定要不要上级别 2                                                     |
| **提 limit 撑长邮件/推送**     | 现有读者体验变差       | §0.5 的 `recipients[].maxItemsPerSection`，归档富、推送瘦；**且必须并入渲染缓存 key**，否则两个上限互相覆盖                                |
| **cron 到点归档还没就绪**      | 当天漏发               | skip + warning + **exit 0**（不误报）；`catchUpDays` 次日自动补                                                                            |
| **周一两篇**                   | 同日两次外发           | 两条 cron 相隔 1 小时；不想要就 `daily.skipWeekdays: [mon]`                                                                                |
| **每天一篇的频率触发平台判定** | 账号受限               | §6.5 分阶段（先草稿后自动）；`minItems` 保证每篇有实质内容；footer 写明编辑口径（§3.4）；`failStreakLimit` 熔断避免撞墙                    |
| **掘金改接口/字段**            | 发布全线失败           | 端点与字段名集中在文件顶部常量块；失败即告警；**日报/邮件/Pages 完全不受影响**                                                             |
| **掘金 Cookie 30 天过期**      | 静默停发               | 失败告警文案直写「去续 Cookie」；`failStreak` 在状态文件里可见                                                                             |
| **境外 runner 触发风控**       | 发布被拒               | ① 先观察，多数能过；② self-hosted runner 放国内；③ 国内 VPS 上放一个极薄转发端点（与 PLAN §8 对企业微信的 Cloudflare Worker 对冲同一模式） |
| **重跑造成重复文章**           | 平台上一堆重复         | §4 的 `contentHash` 幂等 + `published` 状态永不自动重发 + `itemIds` 跨发布去重；M2/M3 验收里各有一条专门测这个                             |
| **改了发布时间忘了生成 cron**  | 时间没变且毫无提示     | cron 由配置生成，`pnpm check:schedule` 覆盖两个 workflow 并跑在 CI 里（§7.2）                                                              |
| **Cookie 泄露进公开仓**        | 账号被盗               | `secretRef` 只写变量名；`lastError` 写入前过 `redactDeep`；单测断言 Cookie 不出现在错误里                                                  |
| Notion API 版本演进            | 建页 400               | 版本号写死 `2025-09-03`；database→data_source 自动解析；`pageRef` 模式作为完全绕开的后路                                                   |
| Notion 大页面 update 中断      | 留下半页内容           | M2 的 update 只改属性不动正文（§5.3）；全量重写必须 `--force` 显式触发                                                                     |
| 发布失败污染早报告警           | 分不清哪边挂了         | 独立 workflow + 独立 `ALERT_REASON` 文案（§7.1、§8）                                                                                       |
| 状态文件与内容归档不同步       | 幂等判定失效           | 两者同目录同前缀，同一个 `commit` step 的 rebase 重试块保护                                                                                |

---

## 12. 明确不做 / TODO

**本期明确不做**（不是忘了，是权衡后放弃）：

- **保留 `workflow_run` 当兜底触发器**——幂等能防重复，但会让发布时刻变得不可预测，与需求 1 冲突；漏发由 `catchUpDays` 覆盖（§7.1）。
- **周报重新按 7 天窗口聚合**——`weekly.ts` 已经做过这个编辑取舍，再做一遍是把同一个判断做两次（§2.1 注释）。
- **Cookie 自动续期**——需要额外 PAT + `gh secret set`，等于给 CI 一个能改自己 secret 的权限，收益不抵风险（决策 16）。
- **无头浏览器**——Puppeteer 比直接打 HTTP 脆弱一个数量级，CI 上装 Chromium 的时间比整个发布流程还长（决策 17）。
- **封面图生成**——两个平台都能不带封面发；真要做是另一个单子。
- **发布数据回流**（阅读量/点赞同步回归档）——先让「发得出去」稳定运行一个月。
- **给 `ai` / `security` 加源**——它们是供给不足而非 limit 不足（§0.4），属于 [SOURCES.md](./SOURCES.md) 的单子。

**TODO（按建议顺序）**：

| 顺序 | 事项                             | 前置条件                    | 预估                                                                      |
| ---- | -------------------------------- | --------------------------- | ------------------------------------------------------------------------- |
| 1    | §0.4 级别 2：提 limit + 推送封顶 | **M4 测出条数中位数 <20**   | 改 4 个 limit + `maxItemsPerSection` + 渲染缓存 key，半天                 |
| 2    | §0.4 级别 3：重开 `releases` 栏  | 级别 2 之后仍嫌少           | `enabled: true` + 用 recipient 白名单把它挡在邮件外                       |
| 3    | dev.to                           | M5 完成                     | 几十行；`POST /api/articles` + `api-key` header，原生支持 `canonical_url` |
| 4    | Hashnode                         | 先确认 GraphQL API 计费额度 | GraphQL `publishPost`，需 publication id                                  |
| 5    | 微信公众号                       | **先解决固定出口 IP**       | 草稿箱 API 需 IP 白名单，是这条路唯一的真障碍                             |
| 6    | CSDN                             | 掘金稳定运行满一个月        | 同为 Tier 2，风险模型一致                                                 |
| 7    | 知乎 / SegmentFault              | 同上                        | 同上                                                                      |
| —    | Medium / 小红书                  | —                           | 不做：无官方发布通道                                                      |

新增一个平台的成本应当是：**一个 `src/publish/<name>.ts` + `PUBLISHERS` 里一行 + 一个 secret + 一段配置**。如果某次新增需要动 `types.ts` / `collect.ts` / `state.ts`，说明 §1.2 的抽象漏了，那才是该停下来重新设计的信号——这条和 §3.4「加一个 channel 是一文件一行」是同一条纪律。

---

## 13. 实施步骤（写给下一个 session）

> 本节是**执行手册**，不是背景介绍。新 session 开工时按 §13.0 建立上下文，然后从当前里程碑的第一个未完成步骤开始做。

### 13.0 开工须知

**读什么**（总预算 ≤10k token，读完直接开工，**不要扫全仓**）：

| 顺序 | 读什么                                                                                       | 为什么                                 |
| ---- | -------------------------------------------------------------------------------------------- | -------------------------------------- |
| 1    | 本文件 §0.4 / §1.2 / §2 / §4                                                                 | 选材口径、数据模型、配置契约、状态机   |
| 2    | 本节 §13 对应里程碑的步骤表                                                                  | 这次要做什么                           |
| 3    | [`src/channels/types.ts`](../src/channels/types.ts) + [`index.ts`](../src/channels/index.ts) | `Publisher` 是照着它写的，包括注释密度 |
| 4    | [`src/archive/read.ts`](../src/archive/read.ts) + [`paths.ts`](../src/archive/paths.ts)      | `collect.ts` 的窗口扫描要复用这里      |
| 5    | 只在动到某文件时才读它                                                                       | —                                      |

**不要读**：`README.md`（34k）、`brief.config.yaml` 全文（31k，只 grep 需要的段）、`docs/PLAN.md`、`docs/LLM-SUMMARY.md`（本文件已经把要用的结论摘出来了）。

**Session 切分**：一个里程碑 = 一个 session。M1 做完 `/handoff` + `/clear`，不要在同一个 session 里跨里程碑——M1 的探索过程对 M2 是纯噪音。

**分支与提交**：分支 `feat/publish-m1`（个人仓，无 TNS 单号）。commit 信息用 `/commit-msg` 生成，**不要代为提交或推送**。

**每一步做完都跑这一串**（[ci.yml](../.github/workflows/ci.yml) 检查项的子集，本地绿了 CI 基本就绿；CI 还会额外跑 `pnpm site:build`，本轮不该影响它）：

```bash
pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm validate && pnpm check:schedule
```

### 13.1 前置手工准备（写第一行代码之前必须做完）

这些是人做的事，agent 做不了。**没做完就开始写代码，会在 M2/M3 卡住**。

| #   | 事项                         | 怎么做                                                                                                                           | 产出                            | 验证                                           |
| --- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ---------------------------------------------- |
| 1   | Notion Integration           | notion.so/my-integrations → New integration → 拿 Internal Integration Token                                                      | `ntn_…`                         | —                                              |
| 2   | Notion 数据库 + 列           | 新建一个 database，按 §5.4 建 6 列：`Name`(title) `Date`(date) `Line`(select) `Summary`(text) `Tags`(multi-select) `Source`(url) | 列名逐字一致                    | 列名拼错 → M2 会报 `validation_error`          |
| 3   | 把 Integration 连到库        | 数据库右上 `…` → Connections → 选第 1 步的 integration                                                                           | —                               | **最常见的坑**：忘了连 → 报 `object_not_found` |
| 4   | 拿 database / data source id | 复制数据库链接，取 URL 里的 32 位 hex                                                                                            | `NOTION_DATA_SOURCE_ID`         | 填 database id 也行，适配器会解析（§5.1）      |
| 5   | 掘金 category/tag id         | 按 §6.3 实抓：写文章页 → F12 Network 筛 `article_draft` → 保存草稿 → 看 payload                                                  | `category_id` + `tag_ids`（≤3） | 抄进 `brief.config.yaml` 并注上中文名          |
| 6   | 掘金 Cookie                  | 同一次请求的完整 Cookie 串                                                                                                       | `JUEJIN_COOKIE`                 | **只进 Secrets**，绝不进配置/日志/状态文件     |
| 7   | GitHub Secrets               | `NOTION_TOKEN` `NOTION_DATA_SOURCE_ID` `JUEJIN_COOKIE`                                                                           | —                               | M3 首跑                                        |
| 8   | GitHub Variables             | `PUBLISH_ENABLED=true`、`PUBLISH_CANONICAL_BASE`（可留空）                                                                       | —                               | —                                              |
| 9   | Environment `publishing`     | Settings → Environments → New → Required reviewers 勾自己                                                                        | 试运行期的人工闸门              | M3 首跑时 job 应挂起等批准                     |

### 13.2 M1 —— 骨架 + 选材（一个 session）

| 步骤 | 改哪些文件                                                                  | 做什么 / 关键约束                                                                                                                                                                                              | 验证                                                                       |
| ---- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| S1   | `src/config/schema.ts`<br>`brief.config.yaml`<br>`test/config.test.ts`      | 加 §2.2 的三个 schema + §2.2 那五条 `superRefine`。**复用现成的 `ID` / `TIME` / `WILDCARD_LIST`，不要另写正则**。配置块照抄 §2.1                                                                               | `pnpm validate` 通过；把 `include` 改成一个不存在的 section → **必须报错** |
| S2   | `src/publish/types.ts`                                                      | 照抄 §1.2。`HttpFetch` 从 `../channels/types` **import 复用，不要复制定义**                                                                                                                                    | `pnpm typecheck`                                                           |
| S3   | `src/publish/collect.ts`<br>`test/publish-collect.test.ts`                  | §1.3 的六步。复用 [`isReprint`](../src/archive/paths.ts) / [`shiftDate`](../src/archive/paths.ts) / [`parseArchiveFilename`](../src/archive/paths.ts)；fs 走 `FsLike` 注入。**新闻栏零放行是第一条要写的测试** | §9 `collect.ts` 那一行的全部用例                                           |
| S4   | `src/render/markdown.ts`<br>`src/publish/adapt.ts`<br>`test/render.test.ts` | §3.2 的 `escape` 注入（默认值不变）+ §3.3/§3.4 的适配与 footer。**先写回归测试再改渲染层**                                                                                                                     | 回归测试：不传 `escape` 时输出与改动前**逐字节相同**                       |
| S5   | `src/publish/state.ts`<br>`test/publish-state.test.ts`                      | §4.1 的读写 + §4.2 的 `decide()` 纯函数 + `failStreak`。写入前过 [`redactDeep`](../src/core/redact.ts)                                                                                                         | §4.2 判定表**逐行**一个用例                                                |
| S6   | `src/publish/index.ts`<br>`src/publish/stdout.ts`<br>`test/publish.test.ts` | `PUBLISHERS` 注册表 + `publishAll()`。**照抄 [`deliver()`](../src/channels/index.ts) 的骨架**：`Promise.all` + 每目标独立 try/catch + 缺 env 是 skip                                                           | 一个 target 抛错不影响另一个                                               |
| S7   | `src/publish.ts`<br>`package.json`                                          | §2.3 的 CLI。参数解析照抄 [`src/cli.ts`](../src/cli.ts) 的 switch 风格；step summary / outputs 复用 [`writeStepSummary`/`writeStepOutputs`](../src/summary.ts)                                                 | 见下面的 DoD                                                               |

**M1 完成定义（DoD）**——五条全绿才算完：

```bash
# ① 选材正确：技术条数 ≥20，新闻栏 0 条
pnpm publish:run --schedule daily --date 2026-08-22 --dry-run --explain

# ② 正文干净：肉眼检查无 `\[`、无「生成时间」、无「## 告警」
# ③④⑤
pnpm test && pnpm typecheck && pnpm lint && pnpm format:check && pnpm validate
```

> ① 用 `2026-08-22` 是因为那天 `morning`+`evening` 两期都在归档里（17+12 条技术），正好验证合并。

### 13.3 M2 —— Notion（一个 session）

| 步骤 | 改哪些文件                                                   | 做什么 / 关键约束                                                                                                                                  | 验证                            |
| ---- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| S8   | `src/publish/markdown.ts`<br>`test/publish-markdown.test.ts` | §5.2 的六种结构 + 分批。**只支持那六种**，其余落 `paragraph`；rich text >2000 字要切                                                               | 99/100/101 三个分批边界用例     |
| S9   | `src/publish/notion.ts`<br>`test/publish-notion.test.ts`     | §5.1 的端点序列。`Notion-Version` **写死 `2025-09-03`**；database→data_source 解析**只做一次**；append 串行（约 3 req/s）；update 只改属性（§5.3） | 假 fetch 断言请求序列与 payload |
| S10  | —                                                            | 真实联调：`pnpm publish:run --schedule daily --targets notion-archive`                                                                             | 见下面的 DoD                    |

**M2 DoD**：① Notion 库出现该期，6 个属性齐全，**30 条正文完整分批写入**；② **再跑一次 → `skipped`，库里没有第二条**；③ 改一个字后跑 → 属性更新且 `detail` 写明「正文未同步」。

### 13.4 M3 —— cron + 掘金草稿（一个 session）

| 步骤 | 改哪些文件                                                                                        | 做什么 / 关键约束                                                                                                                                                                                    | 验证                                             |
| ---- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| S11  | `src/publish/juejin.ts`<br>`test/publish-juejin.test.ts`                                          | §6.2 的三个端点，**集中在文件顶部常量块**。`err_no !== 0` 即抛（改造 [`assertOkCode`](../src/channels/types.ts)）。**第一个 commit 就要写「`autoPublish: false` 时绝不调 `article/publish`」的测试** | 断言 `edit_type: 10`；Cookie 不出现在任何错误里  |
| S12  | `src/schedule/cron.ts`<br>`src/schedule/generate.ts`<br>`package.json`<br>`test/schedule.test.ts` | 把 `generateCrons()` 参数化，让它也能读 `config.publish.schedules`（`weekday` 走现成的 `weeklyToUtcCron`）；`generate.ts` 加 `--kind brief\|publish`；`check:schedule` 校验**两个** workflow         | `pnpm check:schedule` 对两个 workflow 都能报漂移 |
| S13  | `.github/workflows/publish.yml`                                                                   | 照抄 §7.3。cron 块用 `pnpm publish:schedule --write` **生成，不手写**                                                                                                                                | 生成结果与 §7.2 一致                             |
| S14  | —                                                                                                 | 首次真实运行（`environment: publishing` 已开，job 会挂起等批准）                                                                                                                                     | 见下面的 DoD                                     |

**M3 DoD**：① `pnpm check:schedule` 两个 workflow 都通过；② 09:30 自动触发，掘金草稿箱出现文章、**打开编辑器格式无异常**；③ 重跑 → `skipped`，草稿箱没有第二篇；④ 故意填错 Cookie → 企业微信收到「Cookie 已过期」；⑤ **删掉当天归档跑一次 → skip + warning 且 exit 0**（不是 failure）。

### 13.5 M4 —— 观察期两周（不写代码）

每天在草稿箱看一眼，填这张表。**它的唯一目的是回答一个只能测量、不能推断的问题：条数够不够、格式炸不炸。**

| 日期 | 发布线 | 技术条数 | 格式问题 | Cookie 是否失效 | 备注 |
| ---- | ------ | -------- | -------- | --------------- | ---- |
|      |        |          |          |                 |      |

**判定**：连续 10 期无格式异常 + 条数中位数 ≥20 + Cookie 未失效 → 进 M5。
条数中位数 **<20** → 先做 §12 TODO 第 1 项（§0.4 级别 2：提 `tech`/`cn-tech` 的 limit + `recipients[].maxItemsPerSection`），再进 M5。

### 13.6 M5 —— 转自动 + 收口

1. `targets[].autoPublish: true`（掘金），关掉 `environment: publishing` 的 required reviewer；
2. 验证熔断：人为造三次失败 → 第四次不再请求，告警写「已熔断」；
3. Notion 正文全量重写（`--force`，§5.3）；
4. README 补「配置发布目标」小节。

### 13.7 编码约束（本仓既有约定，必须遵守）

| 约束                         | 说明                                                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **不新增运行时依赖**         | Notion 和掘金都用 `fetch` 直打。不要装 `@notionhq/client`——它会把 Notion 版本锁进 package.json，与 §5.1 的显式版本策略冲突 |
| **所有网络走注入的 fetch**   | `PublisherContext.fetchImpl`，单测永不联网                                                                                 |
| **错误进状态前先 redact**    | 本仓是公开仓，`lastError` 可能带 Cookie 片段                                                                               |
| **一文件一平台，注册表一行** | 新平台不该需要改 `types.ts` / `collect.ts` / `state.ts`（§12 末尾那条纪律）                                                |
| **注释写「为什么」**         | 本仓注释密度高但全是决策理由，不是代码复述。照着 `channels/types.ts` 的调子写                                              |
| **测试文件命名**             | `test/publish-*.test.ts`，与现有 `enrich-*.test.ts` 同风格                                                                 |
| **不动 pipeline**            | `src/core/**` 只读不改。唯一例外是 §0.5 的 `maxItemsPerSection`，而那属于 §12 TODO 第 1 项，不在 M1–M5                     |
| **不动 `daily-brief.yml`**   | 发布是独立 workflow（决策 3）                                                                                              |

### 13.8 这几件事这轮不要做

- 加 dev.to / Hashnode / CSDN（§12 TODO，等 M5）；
- 给 `ai` / `security` 加源（属于 SOURCES.md 的单子）；
- 封面图、发布数据回流、Cookie 自动续期、无头浏览器（§12 明确不做）；
- 在 `publish.yml` 上再挂一个 `workflow_run` 兜底（§7.1 已否决）；
- 周报重新按 7 天窗口聚合（`weekly.ts` 已经做过这个判断）。

---

## 参考

- Notion — [Upgrade guide 2025-09-03](https://developers.notion.com/guides/get-started/upgrade-guide-2025-09-03)、[FAQs 2025-09-03](https://developers.notion.com/docs/upgrade-faqs-2025-09-03)、[Append block children](https://developers.notion.com/reference/patch-block-children)
- Notion 限额实践 — [How to Handle Notion API Request Limits](https://thomasjfrank.com/how-to-handle-notion-api-request-limits/)
- 掘金 Web 接口的社区实践 — [一键自动化博客发布工具（掘金篇）](https://developer.aliyun.com/article/1510701)、[chenzijia12300/juejin-api](https://github.com/chenzijia12300/juejin-api)
- 一文多发工具的既有形态 — [wechatsync/Wechatsync](https://github.com/wechatsync/Wechatsync)、[ArtiPub 0.1.5](https://www.oschina.net/news/131216/artipub-0-1-5-released)
- 本仓上下文 — [PLAN.md](./PLAN.md) §0.4 Actions 限制 / §3.4 渠道抽象 / §3.5 归档提交 / §8 风险表、[LLM-SUMMARY.md](./LLM-SUMMARY.md) §3.2 耗时预算 / §9 M3 导读、[SOURCES.md](./SOURCES.md)
- 条数实测 — `archive/2026/08/` 2026-08-20 至 08-24 共 9 期（8 期日报 + 1 期周报），统计口径见 §0.4
