# NEW PRODUCT — `daily-brief`：GitHub Actions 定时早报推送

> 状态：**待实施计划书**（本文档只定义「做什么 / 怎么做 / 怎么验」，不含代码）
> 目标：每天早上把「国际技术 + 科技/国际新闻」聚合成一份早报，推送到我的企业微信 / Gmail，
> 并把每期成品归档进仓库。**推送内容可配置，推送对象可配置。**
> 载体：**独立仓 `git@github.com:MashyGGG/daily-brief.git`**（公开）— 仓库根即工作区，
> 含 `.github/workflows/daily-brief.yml` 与 `archive/` 目录（每期成品提交进 `main`）。
> 本文件是这个新产品的**来源规格**，留在 app-platform 的 `docs/spec/` 作为决策记录；
> 新仓建好后把它复制一份到 `daily-brief/docs/PLAN.md` 作为实施依据。

## 已定决策（v4）

| # | 决策 | 影响 |
| - | ---- | ---- |
| 1 | **邮件走 Gmail SMTP**（App Password） | 零成本、零域名、收件人任意；Resend 只留驱动位（§0.1–0.2） |
| 2 | **微信走企业微信群机器人** | 无第三方中转；正文 4096 字节上限必须分块（§0.5、§3.4） |
| 3 | ~~归档进侧分支~~ → **归档提交进默认分支（`main`）** | 侧分支会让定时任务 60 天后被静默禁用（§0.7 核实），改回 main 后 keepalive 天然成立；孤儿分支 / worktree / `LAST-RUN.md` 补丁全部作废（§3.5） |
| 4 | **早报北京时间 08:00，不追求准点** | 默认生成 cron `0 0 * * *`（UTC），实际到达 08:00–08:30；时间本身由决策 7 管（§3.6） |
| 5 | **LLM 摘要不进 v1** | 排序改为纯代码加权（§3.3）；LLM 移入 §7 扩展 |
| 6 | ✅ **独立公开仓 `git@github.com:MashyGGG/daily-brief.git`** | 与 app-platform 零耦合；归档进它自己的 `main` 完全无副作用，`.prettierignore` 补丁不再需要（§0.7） |
| 7 | **推送时间也要可配置** | cron 不能读配置（GitHub 限制），改为「配置为源 → 生成 cron → 漂移守卫」，并支持多时段（§3.6 ★） |

> 修订历史：v2 核查了本仓邮件基建（结论：**发不出，但不需要付费**）；
> v3 落定渠道与时间；v4 **推翻了 v3 的侧分支归档**——见 §0.7 的核实结论。

---

## 0. 调研与核查结论

### 0.1 ★ 本仓的邮件发送是真的吗？—— 核查结论：**代码是真的，但从未真正发出过一封**

逐条查证：

| 证据 | 说明 |
| ---- | ---- |
| `packages/shared/src/email.ts:1` | 真的引入了 `resend` SDK，`packages/shared/package.json` 里 `resend: ^4.1.1` 是真依赖 |
| `email.ts:5-11` `getResend()` | 读 `process.env.RESEND_API_KEY`，**为空就返回 `null`** |
| `email.ts:66-70` / `email.ts:96-100` | `if (!client) { console.info('[email:dev] …'); return false }` —— 直接打印到控制台并返回 |
| `.env.example:40` | `RESEND_API_KEY=""` —— **空** |
| `.env.remote.example:38` | `RESEND_API_KEY=` —— **空**（连"真实 Neon/Upstash"的那份也是空） |
| `docker-compose.apps.yml:38` | 注释原文：`# No RESEND_API_KEY: sign-in codes are printed to the container log` |
| `.github/workflows/ci.yml` | **全文没有 `RESEND_API_KEY`** —— 它不在任何 job 的 secrets 里 |
| `docs/DAILY-SPEAKING.md:87` | 早就写明：`Codes print to the server log when RESEND_API_KEY is unset` |

**结论：你的直觉是对的。** 每一次调用都走 `console.info` 分支，`resend` 那几行 API 代码在本仓**从未被执行过**。它是"写好了但没接线"，不是"能用的邮件通道"。

**但"发不出"的原因不是要付费。** Resend 2026 年的实际条款：

| 项 | 免费版事实 |
| -- | ---------- |
| 额度 | **3,000 封/月、100 封/天**，1 个自定义域名，日志留 30 天 —— 每天一封早报＝30 封/月，远在免费额度内 |
| 但是 | **必须验证一个自有域名才能正常发信** |
| 没有域名时 | 只能用共享发件人 `onboarding@resend.dev`，**且只能发给你注册 Resend 账号时用的那个邮箱**（官方定位为 sandbox，防滥用） |

即：Resend 免费版不要钱，但没域名就只能发给一个固定地址 —— 恰好能满足"推给我自己"，却**直接和"推送对象可配置"冲突**，加第二个收件人的那天就废了。

### 0.2 ✅ 决策 1：邮件走 **Gmail SMTP**，Resend 降级为可选驱动

| 方案 | 要钱吗 | 要域名吗 | 收件人任意吗 | 额度 | 结论 |
| ---- | ------ | -------- | ------------ | ---- | ---- |
| **Gmail SMTP + App Password** | 否 | 否 | **是** | 免费账号 **500 封/24h 滚动窗口** | ✅ **已选定** |
| QQ / 163 邮箱 SMTP + 授权码 | 否 | 否 | 是 | 百封/天量级 | 备选（Gmail 被限时的退路） |
| Resend（有自有域名） | 否 | **是** | 是 | 3000/月、100/天 | 留驱动位，有域名再切 |
| Resend（无域名） | 否 | 否 | **否** | 同上 | 不采用 —— 违反"对象可配置" |

实现：`nodemailer` + `smtp.gmail.com:465`(SSL)，`SMTP_PASS` 用 **App Password**（前提：Gmail 账号已开两步验证，否则生成不了 App Password —— 这是 M1 的前置手工步骤）。

一个容易走错的岔路：**不要用 [`dawidd6/action-send-mail`](https://github.com/dawidd6/action-send-mail) 这类 Action 发信。** 它的收件人写在 workflow 的 `with:` 参数里，而本需求要求收件人来自**配置文件 + secret 覆盖**，写进 YAML 步骤就等于把"可配置"钉死在 CI 定义中。发信必须发生在 CLI 代码内部。

> **范围声明**：`packages/shared/src/email.ts` 的现状（未接线）是本次核查的**发现**，不是本计划的修理对象。
> app-web 的 OTP / 重置密码要不要一并切到 SMTP，是另一张单子。`daily-brief` **不复用** `packages/shared` 的
> 发信函数，自己实现 `channels/email.ts`——它要的是「多收件人 + 双驱动 + 早报模板」，与 OTP 的形状不同。

### 0.3 现成轮子 vs 自建

| 方案 | 是什么 | 结论 |
| ---- | ------ | ---- |
| [TrendRadar](https://github.com/sansan0/TrendRadar) | Python，`config.yaml` + 关键词文件驱动，11 平台 + RSS，9 个推送渠道，Actions 跑 | **不直接用，但抄它的配置分层**：源+渠道 / 关键词 / 模板三者分离 |
| [DailyBrief](https://linux.do/t/topic/2230233) | 23 个源 → LLM 中文摘要 → 日报 | 其 LLM 部分对应本计划的 §7 扩展 |
| [ai-daily](https://github.com/YeeKal/ai-daily) / [ai-news-aggregator](https://github.com/SuYxh/ai-news-aggregator) | 400+/80+ 源，LLM 打分排序 | 抄「抓取和去重用纯代码」的分工 —— v1 连打分也用纯代码 |
| **自建 TypeScript（选定）** | v1 约 700 行（去掉 LLM 后更薄） | 单一语言、沿用 `zod` / `vitest` / eslint / prettier 体系；配置契约自己定 |

### 0.4 GitHub Actions 定时任务的真实限制

| 事实 | 影响 | 对冲手段 |
| ---- | ---- | -------- |
| `schedule.cron` **只认 UTC**，不认时区、不认夏令时 | 北京 08:00 要换算成 UTC | 见 §3.6 的 cron 选择 |
| 定时**普遍延迟 5–30 分钟**，整点尤其拥挤，高峰期甚至整次跳过 | 到达时间在 08:00–08:30 浮动 | 决策 4 已接受不准点；时间窗用 `lookbackHours` 回溯，跳一次不丢内容 |
| **公开仓**连续 60 天无活动 → 定时工作流被静默禁用；判定**只认默认分支上的提交** | 某天起早报悄悄不发了 | ★ 归档每天提交进默认分支（决策 3）= 计时器天天重置，见 §0.7 |
| 失败时没有任何通知 | 「没收到早报」≠「今天没新闻」 | 任一渠道失败 → 用同样的渠道发失败告警，且 job 最终 `exit 1` |
| 公开仓 Actions 分钟数免费 | — | 单次 1–2 分钟 × 30 天，零成本 |

### 0.5 ✅ 决策 2：微信走**企业微信群机器人**

| 渠道 | 免费额度 | 状态 |
| ---- | -------- | ---- |
| **企业微信群机器人** | 免费，**20 条/分钟**；markdown 正文 **上限 4096 字节（UTF-8）** | ✅ **已选定**，无第三方中转 |
| Server酱³ | 新版免费号 **5 条/天** | 留接口，默认 `enabled: false` |
| PushPlus | **200 条/天**，5 条/分钟 | 同上 |
| WxPusher | **500 条/天**，消息只留 7 天 | 同上 |

风险：GitHub 托管 runner 在境外，访问 `qyapi.weixin.qq.com` 走公网，正常可达但**不保证**；一旦不通，兜底是 Cloudflare Worker 中转或自托管 runner（风险表里有，不预先实现）。**这也是邮件渠道必须能用的另一个理由：它是不同链路的冗余。**

### 0.6 内容源：只做三种 fetcher，其余全靠配置

| 类型 | 实现 | 覆盖 |
| ---- | ---- | ---- |
| `rss` | 拉 XML → `fast-xml-parser` | The Verge / Ars Technica / TechCrunch / Lobsters / Cloudflare Blog / Next.js Blog / AWS What's New / BBC World / arXiv / 任何 GitHub Releases 的 `.atom` |
| `hackernews` | [HN Algolia API](https://hn.algolia.com/api)：`search?tags=front_page`、`search_by_date?numericFilters=points>100`，**免鉴权免费** | HN 头版 / Show HN / 高分新帖 |
| `github` | `api.github.com/search/repositories?q=created:>YYYY-MM-DD+language:X&sort=stars`，用 Actions 自带的 `GITHUB_TOKEN` | GitHub Trending 的等价物（**官方无 Trending API，绝不爬 HTML 页面**） |

新增一个源 = 配置文件里加 6 行，**不改代码**。这就是「内容可配置」的落点。

### 0.7 ★ 归档放哪 + 仓库放哪（决策 3 与决策 6）

**核实结论：GitHub 的 60 天判定只认默认分支上的提交。** 往侧分支推一万次，`main` 的计时器一动不动。
这个结论对"本仓侧分支"和"新仓侧分支"都成立，但严重程度天差地别：

| 场景 | main 上有没有别的活动 | 侧分支归档的后果 |
| ---- | -------------------- | ---------------- |
| 留在 `app-platform`，归档进侧分支 | 有——你每天写代码往 main 合 | 只是**没帮上忙**，人类活动兜住了计时器 |
| **新建独立仓，归档进侧分支** | **没有**——这个仓存在的唯一目的就是自动跑 | **60 天后必被禁用，是必然事件而非风险** |
| 任一仓，**归档进默认分支** | — | 每天一次提交，计时器天天重置，问题消失 |

→ **决策 3 改为归档进默认分支**，v3 的孤儿分支 + git worktree + `LAST-RUN.md` 月度指针补丁**全部作废**。

**✅ 决策 6 已定：独立公开仓 `git@github.com:MashyGGG/daily-brief.git`。**

选它而非塞进 `app-platform` 的理由，按重要性排：

| | 独立仓（选定） | 留在 app-platform |
| -- | ---- | ---- |
| 耦合度 | 干净独立 | **零共享面**：不共享 DB、不共享部署、不共享 release tag、不共享依赖，纯搭便车 |
| 归档进 main 的副作用 | **无** —— CI 规则自己定，没有 `format:check` 会看到归档 | 每天一个 bot 提交混进真实代码历史；且**必须加 `.prettierignore`**（根级 `pnpm format:check` 覆盖全仓 `*.md`，机器生成的 md 必然让下个 PR 变红） |
| CI 触发 | 空仓，没有任何遗留触发器 | `ci.yml` 只监听 `pull_request→main` / `release`，push main 不触发（安全但要记住） |
| 工具链 | 需自建 eslint / prettier / tsconfig / vitest 四件套（一次性，半小时） | 白拿 turbo 那套 |
| Actions 额度 | 公开仓免费 | 公开仓免费 |

代价只有"自建四个配置文件"这一项，换来的是彻底零干扰 —— 以及本文档后面所有条件分支的消失。

> **因此本文档以下内容一律以独立仓为准**：路径中的 `daily-brief/` 即仓库根，
> 命令是 `pnpm brief` 而非 `pnpm --filter …`，且**不再需要 `.prettierignore` 补丁**。

---

## 1. 产品定义

一句话：**一个每天早上把「我关心的国际技术与新闻」按我配的栏目、发给我配的收件人、并把当天成品归档进仓库默认分支的 CLI，由 GitHub Actions 定时调用。**

### 1.1 明确不做（v1 范围外）

- 不做 Web 界面、不做订阅注册、不做数据库（**不依赖 `@app/db`**，与 `blog-web` 同类）
- 不做多用户 / 多租户 —— 收件人是「我和我指定的几个人」
- 不做中文热榜（知乎/微博/B 站），本需求明确是**国际**技术与新闻
- 不做全文抓取与正文解析，只用标题 + 摘要 + 链接
- **不做 LLM 摘要**（决策 5，移入 §7）
- 不修 `packages/shared/src/email.ts`（见 §0.2 范围声明）
- 归档只进仓库的 `archive/` 目录，**不**做成 `blog-web` 的公开页面（见 §7）

---

## 2. 工作区形态

```
daily-brief/                           # 仓库根（MashyGGG/daily-brief）
  .github/workflows/daily-brief.yml    # ★ on.schedule 区块由 pnpm brief:schedule 生成
  .gitignore | eslint.config.mjs | .prettierrc | vitest.config.mts   # 自建的四件套
  package.json                         # private, type: module；脚本 brief / validate / typecheck / lint
  tsconfig.json
  brief.config.yaml                    # ★ 唯一的内容 & 收件人配置，入库
  README.md                            # Gmail App Password / 企微 webhook 的操作手册
  archive/                             # ★ 每日归档，直接提交进默认分支（见 §3.5）
    index.md                           #   最近 30 期目录，每次运行重写
    2026/08/2026-08-20.md              #   当期成品
    2026/08/2026-08-20.json            #   当期结构化条目
  src/
    index.ts                           # CLI 入口：解析参数 → 跑 pipeline → 写 GITHUB_STEP_SUMMARY
    config/schema.ts                   # zod schema + loadConfig()：配置非法 = 直接失败，不静默跳过
    sources/rss.ts | hackernews.ts | github.ts
    sources/index.ts                   # type → fetcher 注册表
    core/normalize.ts                  # 任意源 → Item
    core/dedupe.ts                     # URL 规范化去重 + 标题近似去重 + 跨天去重（读 archive/）
    core/filter.ts                     # include/exclude 关键词、最低分、时间窗
    core/rank.ts                        # ★ v1 的排序：纯代码加权（见 §3.3）
    schedule/cron.ts                   # ★ 时区→UTC cron 生成 + github.event.schedule 反查（见 §3.6）
    render/markdown.ts | html.ts | text.ts
    archive/write.ts | read.ts         # 归档读写 + index.md 重建
    channels/wecom.ts | email.ts | serverchan.ts | pushplus.ts | wxpusher.ts | telegram.ts
    channels/index.ts                  # Channel 接口 + 注册表
  test/                                # vitest：只测纯函数（见 §6）
```

**依赖**：`zod`（本仓已用）、`yaml`、`fast-xml-parser`、`nodemailer`（+ `@types/nodemailer`）。运行用根 devDep 的 `tsx`，**不加 build 步骤** —— 它不进 Vercel，不需要产物。

**不变量遵守**：不含任何 `*.prisma`、不依赖 `prisma` CLI → `pnpm check:schema-owner` 天然通过。

### 2.1 Item 契约（所有源归一到这个形状，也是归档 JSON 的元素）

```ts
interface Item {
  id: string // 规范化 URL 的 hash，去重主键
  title: string
  url: string
  source: string // 配置里的 source.name
  section: string // 归档时落定的栏目 id
  publishedAt: string // ISO；源没有就用抓取时间
  score?: number // HN points / GitHub stars / RSS 无
  rankScore: number // ★ core/rank.ts 算出的最终排序分，入归档便于回溯
  author?: string
  excerpt?: string // 源自带摘要，截断到 300 字
}
```

---

## 3. 详细设计

### 3.1 配置文件：内容与对象的双向可配

`brief.config.yaml`（仓库根，入库，可 review，可回滚）：

```yaml
timezone: Asia/Shanghai # 渲染文案的时区，也是下面 schedules 里 time 的时区

schedules: # ★「推送时间」的可配置单位（决策 7，见 §3.6）
  - id: morning
    time: '08:00' # 本地时间（timezone 所指）；生成 cron 时换算成 UTC
    lookbackHours: 24 # 时间窗；跳过一次运行也不丢内容
    sections: ['*'] # 这个时段推哪些栏目
    recipients: ['*'] # 这个时段推给谁
    enabled: true
  # - id: evening        # 想加个晚间技术速览就解开这段，跑一次 pnpm brief:schedule
  #   time: '20:00'
  #   lookbackHours: 12
  #   sections: [tech]
  #   recipients: [me-wecom]
  #   enabled: true

sources:
  - name: hn-front
    type: hackernews
    weight: 1.2 # ★ v1 排序权重（见 §3.3）
    params: { mode: front_page, minPoints: 100 }
  - name: gh-trending-ts
    type: github
    weight: 1.0
    params: { language: typescript, createdWithinDays: 7, minStars: 50 }
  - name: verge
    type: rss
    weight: 0.9
    params: { url: https://www.theverge.com/rss/index.xml }
  - name: bbc-world
    type: rss
    weight: 1.0
    params: { url: http://feeds.bbci.co.uk/news/world/rss.xml }

sections: # ★「推送内容」的可配置单位
  - id: tech
    title: 国际技术
    sources: [hn-front, gh-trending-ts]
    limit: 8
    minPerSource: 1 # 防止单一源霸榜
    include: [] # 空 = 不过滤
    exclude: ['crypto', 'NFT']
  - id: news
    title: 国际要闻
    sources: [verge, bbc-world]
    limit: 5

archive: # ★「归档」的可配置单位（见 §3.5）
  enabled: true
  dir: archive # 提交进默认分支，不再有侧分支 / worktree
  indexKeep: 30 # index.md 只列最近 30 期；文件本身永久保留
  commit: true # 本地跑时置 false / 用 --no-commit

recipients: # ★「推送对象」的可配置单位
  - id: me-wecom
    channel: wecom
    secretRef: WECOM_WEBHOOK_ME # 只写「取哪个 secret」，绝不写值
    sections: [tech, news]
    format: markdown
    enabled: true
  - id: me-gmail
    channel: email
    driver: smtp # smtp（选定）| resend（有自有域名时再切）
    to: it@seechange-edu.com
    sections: ['*']
    format: html
    enabled: true
  - id: backup-serverchan
    channel: serverchan
    secretRef: SERVERCHAN_KEY
    sections: [tech]
    format: markdown
    enabled: false
```

四条硬规则：

1. **配置里永远不出现密钥值**，只出现 `secretRef`（env 变量名），运行时解析；`secretRef` 指向的 env 缺失 → 该收件人跳过并在汇总里记 `skipped`，不影响其他人。
2. **配置非法 = 进程失败**，不静默跳过 —— 与 `blog-web` 的 `post-meta.ts`「frontmatter 写错就构建失败，绝不让文章悄悄消失」是同一条哲学。zod 校验 + `pnpm validate` 进 CI。
3. **私密收件人**（不想入库的地址/webhook）走 `RECIPIENTS_OVERRIDE_JSON` secret，运行时与 YAML 的 `recipients` 按 `id` 合并覆盖。
4. `driver: resend` 且 `EMAIL_FROM` 仍是 `onboarding@resend.dev` 时，**zod 校验直接报错**并提示 §0.1 的沙箱限制 —— 不让人再踩一次「以为发出去了其实只发给了自己」。

### 3.2 Pipeline

```
loadConfig ─┬─ readArchive(近 14 天，从 archive/) ─┐（提供跨天去重的 seen 集合）
            ├─ fetch(sources) 并发 ──► normalize ──┴─► dedupe(本次 + 跨天)
            │        └─ 单源失败：记 warning，不中断（源挂了不该毁掉整份早报）
            ├─ filter(关键词/分数/时间窗) ──► rank ──► 按 section 截断
            ├─ writeArchive(md + json + 重建 index.md)   ★ 先归档，后推送
            ├─ render × N（按 recipient 的 sections 签名去重渲染，不是每人渲一次）
            ├─ deliver 并发（每个 recipient 独立 try/catch）
            └─ commit&push archive ──► 汇总写入 $GITHUB_STEP_SUMMARY
```

**顺序刻意如此：归档在推送之前。** 推送可能因企微/Gmail 抽风而失败，但内容已经产出 —— 内容不该跟着通道一起丢。归档成功、推送失败时，job 失败但仓库里有今天的早报，可以 `--from-archive 2026-08-20` 手动重发。

**空内容处理**：过滤后 0 条 → 不推送、不归档，只写 step summary（「今天没有达标内容」），避免每天一封空邮件把人训练成忽略它。

### 3.3 ✅ 决策 5：v1 不用 LLM，排序用纯代码加权

去掉 LLM 后，「哪 8 条上榜」必须由确定性规则决定。v1 的 `rankScore`：

```
rankScore = sourceWeight × ( 0.6 × normScore + 0.4 × recency )
  normScore = 该条在其源内的分数分位（HN points / GitHub stars；RSS 无分数则取 0.5 中位）
  recency   = 1 - (now - publishedAt) / lookbackHours，clamp 到 [0, 1]
```

外加两条结构性规则：

- `minPerSource`：每个源在本栏至少保留 1 条，避免 HN 把整栏吃掉；
- 同 `section` 内按 `rankScore` 降序，截断到 `limit`。

摘要则退化为**源自带的 `description` / `excerpt` 截断到 300 字**（RSS 与 HN 都有；GitHub 用仓库 description）。
这条路的好处是**完全可测**（纯函数，进 vitest 边界表），且没有 API key、没有额度、没有降级分支。
LLM 版的中文摘要与跨条导读见 §7 —— 归档 JSON 里已经存了原始 `Item`，将来补 LLM 可以**回放历史归档重新生成**，不需要重抓。

### 3.4 渲染与渠道

| 渠道 | 格式 | 关键约束 |
| ---- | ---- | -------- |
| `wecom` ✅ | markdown | **4096 字节**（不是 4096 字符！中文 3 字节/字）→ 必须按「不切断条目」的规则分块，块间 sleep ≥ 3s 规避 20 条/分钟 |
| `email` (driver `smtp`) ✅ | HTML | `nodemailer` + `smtp.gmail.com:465`；`SMTP_PASS` 用 App Password；内联样式、无外链 CSS、带纯文本 fallback |
| `email` (driver `resend`) | HTML | 仅在**已验证自有域名**后启用；否则见 §3.1 规则 4 |
| `serverchan` / `pushplus` / `wxpusher` | markdown/text | 各自额度见 §0.5；默认 `enabled: false` |
| `telegram` | MarkdownV2 | 4096 **字符**上限；需转义 `_*[]()~>#+-=\|{}.!` 与反引号 |

`Channel` 接口：

```ts
interface Channel {
  readonly name: string
  send(input: { title: string; body: string; recipient: Recipient }): Promise<void>
}
```

加一个渠道 = 加一个文件 + 注册表一行 + 一张边界测试表。

### 3.5 ✅ 决策 3：归档提交进默认分支

归档同时承担第二个职责：**它就是 state**。原方案有个只为跨天去重存在的 `state.json`；既然每期成品都要入库，去重直接读最近 14 天的归档 JSON，不需要第二份状态。

**产物三件套**（`archive/`）：

| 文件 | 内容 | 谁读 |
| ---- | ---- | ---- |
| `2026/08/2026-08-20.md` | 当天渲染成品（分栏、条目、来源脚注） | 人；`--from-archive` 重发 |
| `2026/08/2026-08-20.json` | `{ date, generatedAt, configHash, items: Item[], warnings: [] }` | 去重、统计、将来补 LLM 回放 |
| `index.md` | 最近 30 期的日期 + 条目数，每次运行重写 | 人（在仓库首页直接翻） |

**提交方式**（workflow 末尾，普通 git，无 worktree、无侧分支）：

```bash
git add archive/
git diff --cached --quiet || {
  git -c user.name='github-actions[bot]' \
      -c user.email='41898282+github-actions[bot]@users.noreply.github.com' \
      commit -m "chore(daily-brief): archive 2026-08-20"
  git pull --rebase && git push        # 重试 ×3
}
```

**为什么这就解决了 keepalive**：公开仓 60 天不活跃会静默禁用定时工作流，而判定**只认默认分支上的提交**（§0.7 已核实）。每天一次归档提交＝计时器天天重置，离 60 天上限有 60 倍余量。v3 里那套孤儿分支 + worktree + `LAST-RUN.md` 月度指针补丁**整个作废**。

**checkout 深度**：workflow 用 `fetch-depth: 1` 即可 —— 所有归档文件都在 tip 的 tree 里，跨天去重读的是文件而非历史。

#### 仍需处理的三件事

1. **并发推送冲突。** bot push 与人类 push 撞车 → `git pull --rebase` 重试 ×3；归档文件按日期命名，天然不冲突。
2. **公开仓 = 归档内容公开可见。** 早报是公开新闻聚合，本身无隐私问题；但 `warnings` 字段可能带上游 URL 与错误信息 —— 写归档前必须**过滤掉任何含 secret 的字符串**（webhook URL、SMTP 口令），由 A16 守住。
3. **仓库膨胀。** 一天约 10 KB（md + json）→ 一年约 4 MB。可接受，**不删历史**；`indexKeep: 30` 只控制 `index.md` 的长度。

> 独立仓的红利：这里**不需要** `.prettierignore` 补丁 —— 新仓的 `format:check` 范围由自己定，把
> `archive/` 排除在 lint/format 之外即可，不存在"机器生成的 md 让别人的 PR 变红"这回事。

**权限**：workflow 需 `permissions: { contents: write }`。新仓默认无分支保护；若以后加了，记得放行 `github-actions[bot]`。

### 3.6 ✅ 决策 4：GitHub Actions 工作流，北京时间 08:00

`.github/workflows/daily-brief.yml`（**独立文件，绝不碰 `ci.yml`** —— `ci.yml` 是发布流水线，混进来会破坏它 `pull_request` / `release` 双触发的语义）：

#### ★ 决策 7：时间怎么做到"可配置"

**硬限制先说清楚**：GitHub Actions 的 `on.schedule.cron` **必须是 workflow YAML 里的字面量** —— `on:` 块不支持任何表达式，读不了 `vars`、读不了 env、更读不了 `brief.config.yaml`。所以时间做不到像 `sources` 那样"改配置立即生效"。三条可选路径：

| 方案 | 改时间要动什么 | 代价 | 取舍 |
| ---- | -------------- | ---- | ---- |
| **A. 配置为源 → 生成 cron → 漂移守卫（选定）** | 改 `brief.config.yaml` 的 `time`，跑一次 `pnpm brief:schedule`，同一个 commit 里带上生成的 workflow | 多一步生成 | 单一真相仍在配置；零浪费；漂移由 CI 拦截 |
| B. cron 每小时跑，脚本判断"现在是不是我配的点" | 只改配置 | 每天 24 次空跑，Actions 历史全是噪音 | 真正的运行时可配，但为一个几乎不变的值付每天 23 次浪费 |
| C. 手改 workflow 的 cron | 改 workflow | 配置与 workflow 两处真相，易忘 | 不采用 |

**选 A，并且和本仓已有的做法同构**：`ci.yml` 用 `prisma migrate diff --exit-code` 守 schema 漂移、`check-schema-ownership.mjs` 守目录约定 —— 这里加第三个同类守卫：

- `pnpm brief:schedule` —— 读配置，按 `timezone` 把每个 `schedules[].time` 换算成 UTC，重写 workflow 的 `on.schedule` 区块（带 `# generated from brief.config.yaml, do not edit` 标记）；
- `pnpm check:schedule` —— 只校验不重写，**不一致就退出码非 0**，进新仓的 CI（可选也挂 pre-commit）。改了时间忘了生成，会在提交/CI 阶段被拦下，而不是某天早上没收到早报才发现。

生成结果（示例，`timezone: Asia/Shanghai` + `time: '08:00'`）：

```yaml
on:
  schedule:
    # generated from brief.config.yaml — run `pnpm brief:schedule` after editing, do not hand-edit
    - cron: '0 0 * * *' # morning · 08:00 Asia/Shanghai
    # - cron: '0 12 * * *'  # evening · 20:00 Asia/Shanghai
  workflow_dispatch:
    inputs:
      schedule: { type: string, default: 'morning' } # 手动触发时指定跑哪个时段
      dry-run: { type: boolean, default: false } # 只渲染 + 只写 archive/，不推送不提交
      recipients: { type: string, default: '' } # 逗号分隔，覆盖配置
      sections: { type: string, default: '' }
      from-archive: { type: string, default: '' } # YYYY-MM-DD：不抓取，直接重发某期
```

**多时段怎么知道是哪个时段触发的**：GitHub 会把触发用的 cron 字符串放进 `github.event.schedule`，workflow 原样传给 CLI（`--cron "${{ github.event.schedule }}"`），CLI 反查配置里对应的 `schedules[].id`，据此选 `sections` / `recipients` / `lookbackHours`。手动触发时走 `--schedule <id>`。反查不到 → **报错退出**，而不是猜一个默认值。

**两个必须处理的细节**：

- **夏令时**：`Asia/Shanghai` 全年不变，安全。但如果哪天把 `timezone` 改成有 DST 的（如 `Europe/London`），生成的 UTC cron 一年会错两次 —— 生成器检测到目标时区有 DST 时**打印警告**并在 workflow 注释里标注，由使用者决定接受还是改用固定偏移。
- **归档同日多期**：多时段意味着一天可能有两份成品 → 归档文件名带时段后缀 `2026-08-20.morning.md` / `.evening.md`，`index.md` 一天可能占两行。单时段时后缀省略，保持 §3.5 的形状。

- `concurrency: daily-brief`（**不**开 cancel-in-progress，宁可排队也别推一半被砍）
- `timeout-minutes: 10`
- `permissions: { contents: write }`
- 步骤：checkout（`fetch-depth: 1`）→ setup-node + pnpm → `pnpm install --frozen-lockfile` → `pnpm brief` → `git add archive/` 提交并推送（重试 ×3）→ 失败告警
- **每次运行都把渲染结果写进 `$GITHUB_STEP_SUMMARY`**：不用等微信就能看见今天发了什么
- 失败告警：`if: failure()` 一步，用 `WECOM_WEBHOOK_ME` 发一行「今日早报失败，见 <run url>」

### 3.7 Secrets / Variables

| 名称 | 类型 | 必需 | 用途 |
| ---- | ---- | ---- | ---- |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | secret | **是** | Gmail：`smtp.gmail.com` / `465` / 你的地址 / **App Password**（需先开两步验证） |
| `EMAIL_FROM` | secret | 是 | 通常 = `SMTP_USER` |
| `WECOM_WEBHOOK_ME` | secret | **是** | 企业微信群机器人 webhook 全 URL |
| `RECIPIENTS_OVERRIDE_JSON` | secret | 否 | 不入库的私密收件人 |
| `SERVERCHAN_KEY` / `PUSHPLUS_TOKEN` / `WXPUSHER_*` / `TELEGRAM_*` | secret | 否 | 启用对应渠道才需要 |
| `RESEND_API_KEY` | secret | 否 | 仅在有自有域名、切 `driver: resend` 时（当前仓库里是空值，见 §0.1） |
| `GITHUB_TOKEN` | 自动注入 | — | `github` 类型源提额 + 归档/指针提交 |
| ~~`LLM_BASE_URL` / `LLM_API_KEY`~~ | — | — | **v1 不需要**，随 §7 的 LLM 扩展再加 |

同步更新 `.env.example`（新增 `SMTP_*` 段，并在 `RESEND_API_KEY` 旁补一行注释说明沙箱限制）；若本地要跑 `pnpm brief`，在 `turbo.json` 的 `globalEnv` 补 `SMTP_*`。

---

## 4. 验收标准（每条都必须可执行验证）

| # | 验收项 | 验证方式 |
| - | ------ | -------- |
| A1 | 本地 `pnpm brief --dry-run` 打印完整早报，不向任何渠道发请求、不提交 | 手动 |
| A2 | 改 `brief.config.yaml` 加一个 RSS 源，**不改任何 .ts**，新源内容出现在早报里 | 手动 |
| A3 | 改某个 recipient 的 `sections`，只有他收到的栏目变化 | `--dry-run` 输出按收件人分组核对 |
| A4 | 配置写错（未知 `channel`、`section` 引用不存在的 `source`、缺 `secretRef`）→ **退出码非 0 且报出具体路径** | vitest 边界表 |
| A5 | 某个源超时/500 → 早报照发，缺失的源出现在 warning 汇总里（并写进归档 JSON） | vitest（注入失败 fetcher） |
| A6 | 一条渠道推送失败 → 其他渠道照发，**归档仍然完成**，job 最终失败并发出告警 | 手动 `workflow_dispatch` 用坏 SMTP 口令 |
| A7 | 连续两天运行，第二天不重复推送第一天已推过的条目（去重源来自归档 JSON，无独立 state 文件） | 手动跑两次 |
| A8 | 企业微信正文超 4096 字节时自动分块，**不在条目中间断开**，中文不乱码 | vitest 边界表（多字节字符边界） |
| A9 | **用 Gmail App Password 真的收到了 HTML 早报**，且收件人是配置文件里写的地址 | 手动，**M1 的硬门槛** |
| A10 | 排序可复现：同一份输入两次运行的 `rankScore` 与上榜条目完全一致；`minPerSource` 生效 | vitest 边界表 |
| A11 | 运行后默认分支出现 `archive/YYYY/MM/YYYY-MM-DD.md` + `.json`，`index.md` 增加一行，且是**一次**提交 | 手动看 commit |
| A12 | 归档提交后 `git status` 干净，且 `archive/` 不参与 lint/format 检查 | 手动 |
| A13 | 连续两天运行后，默认分支的最新提交时间 = 今天（keepalive 计时器确实在被重置） | 手动看 commit 时间 |
| A14 | `--from-archive 2026-08-20` 能不抓取直接重发某期 | 手动 |
| A15 | `driver: resend` + `EMAIL_FROM=onboarding@resend.dev` → 配置校验失败并给出明确提示 | vitest 边界表 |
| A16 | 归档 JSON 的 `warnings` 中不含任何 webhook URL / 口令片段 | vitest（注入含 secret 的错误信息） |
| A17 | 改 `brief.config.yaml` 的 `time` 后跑 `pnpm brief:schedule`，workflow 的 cron 随之改变；**不跑就让 `pnpm check:schedule` 失败** | 手动 + vitest |
| A18 | 启用第二个时段后，两次触发各自只发自己 `sections`/`recipients` 的内容，归档文件带时段后缀 | 手动 `workflow_dispatch --schedule evening` |
| A19 | `--cron` 传一个配置里不存在的 cron 字符串 → **报错退出**，不猜默认值 | vitest 边界表 |
| A20 | `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test` 全绿，`check:schema-owner` / `check:schedule` 通过 | 现有信号 |

---

## 5. 里程碑

| 阶段 | 交付 | 完成标志 |
| ---- | ---- | -------- |
| **M0 骨架** | 工作区 + 配置 schema + CLI + `--dry-run`，只有 `rss` 一种源、只有 stdout 一个「渠道」 | A1 / A4 / A15 / A17 |
| **M1 能收到** | `hackernews` + `github` 源；`email(smtp/Gmail)` + `wecom` 渠道；`brief:schedule` 生成器 + 漂移守卫；workflow 定时跑通 | **A9** / A2 / A3 / A6 / A17 |
| **M2 归档 + 不烦人** | `archive/` 三件套 + 提交回写；跨天去重；失败告警；空内容不推；单源失败隔离 | A5 / A7 / **A11** / A12 / A13 / A14 / A16 |
| **M3 排版打磨** | `rank.ts` 加权调优；HTML 邮件模板；多时段（晚间速览）；`$GITHUB_STEP_SUMMARY` 渲染 | A10 / A18 + 主观满意度 |

M0→M1 是「能用」，M2 是「能长期用」，M3 是「愿意每天看」。
**M1 的门槛是 A9（真的收到邮件）** —— 鉴于 §0.1 揭示的历史，「代码写完了」不算数。
**M2 里 A11 不能跳** —— 归档提交既是产物，也是这套东西 60 天后还活着的唯一保障。

---

## 6. 测试策略（严格对齐 `docs/UNIT-TESTING.md`）

本工作区**不写 E2E**（Playwright 是给两个 Web 应用的）。Vitest 只测纯函数，**不 mock 网络、不 mock SMTP、不起 server**：

| 测试文件 | 边界表内容 |
| -------- | ---------- |
| `config.test.ts` | 合法配置 / 未知 channel / section 引用不存在的 source / recipient 缺 secretRef / limit ≤ 0 / 重复 id / **resend 驱动 + 沙箱发件人（A15）** |
| `dedupe.test.ts` | URL 规范化（`?utm_*`、末尾斜杠、`http` vs `https`、host 大小写）；从归档 JSON 构建 seen 集合 |
| `filter.test.ts` | include/exclude 大小写、中文关键词、minPoints 边界、时间窗刚好落在边界 |
| `rank.test.ts` | 同分稳定排序；`recency` 在窗口两端 clamp；`minPerSource` 与 `limit` 冲突时谁赢；无分数源取中位 |
| `chunk.test.ts` | 4096 字节切分：纯 ASCII / 纯中文 / 混合 / 单条超长 / 恰好 4096 / 4097 |
| `render.test.ts` | markdown 与 HTML 转义（标题含 `<`、`*`、`[]`）；空 section 不渲染标题 |
| `archive.test.ts` | 归档路径生成（跨年跨月）；`index.md` 重建（不足 30 期 / 超过 30 期）；同日重跑覆盖而非追加 |
| `redact.test.ts` | warnings 里的 webhook URL / 口令被打码（A16） |
| `schedule.test.ts` | 本地时间 → UTC cron（跨日边界 `00:30` / `23:30`）；有 DST 的时区触发警告；`github.event.schedule` 反查命中与未命中（A17/A19） |

有网络与文件系统的代码写成「注入 fetcher / 注入 fs」的形状，测试传假函数，**不写临时目录**。

---

## 7. 可选扩展（明确排在 v1 之后）

- **LLM 摘要（决策 5 推迟的部分）**：一次调用产出整份日报的中文摘要 + 3 句导读，走 OpenAI 兼容端点（DeepSeek / OpenRouter），zod 解析、失败降级为原始标题。**归档 JSON 存了原始 `Item`，所以可以回放历史期重新生成，不必重抓。** 成本约 5k in / 2k out tokens/天。
- **周报**：直接读归档 `*.json` 聚合本周高频主题，**零额外抓取**（归档设计的顺带红利）。
- 归档升级为 `blog-web` 公开页（要过 `post-meta.ts` frontmatter 校验、影响 blog-web 发布节奏）。
- 外部 cron（cron-job.org）打 `repository_dispatch` 换准点。
- 关键词订阅告警（命中即刻推，不等早上）。
- 顺手把 `packages/shared/src/email.ts` 也切成 SMTP 驱动（另开单子，见 §0.2）。

---

## 8. 风险与对冲

| 风险 | 影响 | 对冲 |
| ---- | ---- | ---- |
| 公开仓 60 天不活跃 → 定时被静默禁用 | 早报悄悄停更 | 归档每天提交进默认分支（§3.5）；由 A13 守住。**注意：侧分支归档不算数**（§0.7） |
| 误以为 Resend 能直接用 | 邮件一封发不出 | 默认走 Gmail SMTP；resend 驱动 + 沙箱发件人在配置校验阶段直接报错（A15） |
| Gmail App Password 需先开两步验证 | 配置卡住 | M1 前置手工步骤，写进新仓 `README.md`；备选 QQ/163 授权码 |
| Gmail 触发 500 封/24h 或异常登录风控 | 邮件被拒 | 每天 1 封，余量极大；风控时切 QQ/163 |
| Actions 定时延迟/跳过 | 早报晚到或缺一天 | 已接受 08:00–08:30 浮动；`lookbackHours` 窗口使跳过不丢内容 |
| 改了配置时间忘了重新生成 cron | 时间没变，且毫无提示 | `pnpm check:schedule` 漂移守卫进 CI（A17） |
| 把 `timezone` 改成有夏令时的时区 | 一年错两次时间 | 生成器检测到 DST 时打印警告并在 workflow 注释标注 |
| 境外 runner 访问 `qyapi.weixin.qq.com` 不稳 | 微信收不到 | 邮件渠道并行（不同链路）；必要时 Cloudflare Worker 中转 |
| bot 提交与人类提交撞车 | push 失败 | `git pull --rebase` 重试 ×3；文件按日期命名天然不冲突 |
| **公开仓，归档内容任何人可见** | 泄露风险 | 早报本身是公开新闻；`warnings` 写入前打码（A16）；配置只写 `secretRef` |
| 新仓工具链与 app-platform 逐渐分叉 | 两套 eslint/prettier 规则漂移 | 首次从 app-platform 复制配置，之后不追同步 —— 这是独立仓的既定代价，不是缺陷 |
| RSS 源改版/停更 | 某栏空 | 单源失败隔离 + warning 写进归档 JSON；连续 3 天为空的源在汇总里点名 |
| GitHub Search API 限流 | `github` 源失败 | 带 `GITHUB_TOKEN`（5000/h）；失败即跳过 |
| 没有 LLM，排序不够聪明 | 上榜条目质量一般 | v1 用可测的加权规则（§3.3）+ `minPerSource`；不满意就调权重，随时可加 LLM（§7） |
| 每天一封无用早报 | 训练出忽略习惯 | 空内容不推；`limit` 严格截断；M3 的排序调优才是长期价值所在 |

---

## 9. 开工前的三步手工准备

代码之外的前置条件，**M1 之前必须先做完**（都不需要付费）：

1. **Gmail**：账号开两步验证 → 生成 App Password（16 位）→ 存成仓库 secret `SMTP_PASS`，连同 `SMTP_HOST=smtp.gmail.com` / `SMTP_PORT=465` / `SMTP_USER` / `EMAIL_FROM`。
2. **企业微信**：建一个群 → 群设置 → 群机器人 → 添加 → 复制 Webhook 地址 → 存成 secret `WECOM_WEBHOOK_ME`。
3. **仓库**：在 GitHub 建公开仓 `MashyGGG/daily-brief`（已定），然后：

   ```bash
   git clone git@github.com:MashyGGG/daily-brief.git
   cd daily-brief
   # 从 app-platform 复制起手式：eslint.config.mjs / .prettierrc / tsconfig.json / vitest.config.mts / .gitignore
   ```

   并在仓库 Settings → Secrets 里录入 §3.7 那张表里标「是」的六个值。

然后在**新仓的新 session** 里执行 M0（`/ship-feature`，分支 `feat/m0-skeleton`）。

---

## 参考

**邮件**

- [Resend 免费版条款（3,000/月、100/天、1 域名）](https://automationatlas.io/answers/resend-free-tier-explained-2026/)
- [Resend 定价与限制 2026](https://nuntly.com/resend-pricing)
- [Resend 官方：`resend.dev` 域名 403 说明（只能发给账号自身邮箱）](https://resend.com/docs/knowledge-base/403-error-resend-dev-domain)
- [Gmail SMTP 设置与限额（免费账号 500 封/24h，需 App Password）](https://serversmtp.com/limits-of-gmail-smtp-server/)
- [Gmail 发送限额官方说明](https://support.google.com/a/answer/166852)
- [QQ 邮箱开启 SMTP 并获取授权码（备选）](https://developer.aliyun.com/article/1540766)
- [dawidd6/action-send-mail（对照方案，本设计不采用）](https://github.com/dawidd6/action-send-mail)

**聚合与推送**

- [TrendRadar — 多平台聚合 + 9 渠道推送 + Actions](https://github.com/sansan0/TrendRadar)
- [DailyBrief — 23 源 LLM 中文日报](https://linux.do/t/topic/2230233)
- [ai-daily — 400+ 源 LLM 打分推送](https://github.com/YeeKal/ai-daily)
- [ai-news-aggregator — 80+ AI/科技源](https://github.com/SuYxh/ai-news-aggregator)
- [Hacker News API 指南（Algolia + Firebase）](https://cotera.co/articles/hacker-news-api-guide)
- [hnrss.org — HN 自定义 RSS](https://hnrss.org/)
- [企业微信机器人消息发送限制（4096 字节 / 20 条每分钟）](https://blog.csdn.net/weixin_29196891/article/details/159271455)
- [企业微信 (WeCom) 机器人配置指南](https://github.com/blockcell-labs/blockcell/blob/main/docs/channels/zh/06_wecom.md)

**GitHub Actions 定时**

- [Actions 定时工作流完整指南](https://cronuru.com/guides/github-actions-scheduled-workflows)
- [Actions cron 不运行的排查清单](https://cronsignal.io/troubleshoot/github-actions-cron-not-running)
- [Actions 定时延迟讨论（community #156282）](https://github.com/orgs/community/discussions/156282)
- [60 天不活跃禁用 + keepalive 方案](https://github.com/efrecon/gh-action-keepalive)
