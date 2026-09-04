# SPEC: 多平台创作者数据分析平台（工作名 CreatorInsight）

> 状态：v0.2，用户已确认分析对象 / 技术栈 / 视觉模型 / 部署形态（2026-09-04），其余假设见 §9。
> 本 SPEC 是 single source of truth；需求变更改这里，不在代码里偷改。
> 调研过程与来源见同目录 [RESEARCH.md](./RESEARCH.md)。

**已确认的四个基线决策**

| 项 | 决策 |
|---|---|
| 分析对象 | **用户本人**在各平台运营的账号（可多个），不监测他人 |
| 技术栈 | **Next.js（App Router）单仓库**，其它技术选型次要、服务于 Vercel 部署 |
| 视觉模型 | **Qwen3-VL（阿里云百炼，大陆直连）为默认且唯一必选实现** |
| 部署 | **仅部署在 Vercel**，不做自托管 / Docker |

## 1. 需求与动机

- **用户故事**：As a 在抖音 / 小红书 / 快手多平台运营自己账号的内容创作者，I want 把各平台后台的账号与作品数据汇总到一个地方，得到「当前状况、趋势、总结说明、注意事项」的分析报告，so that 不用逐个 App 翻后台、靠记忆对比，能基于数据决定下一步发什么、在哪个平台加码。
- **为什么做**：三家平台后台各自独立，指标口径不一（抖音「播放」、小红书「观看/阅读」、快手「播放」；小红书独有「收藏」），没有跨平台视角；官方数据接口要么没有（小红书），要么需要应用审核 / 企业认证（抖音、快手）；第三方数据平台（新榜、蝉妈妈、灰豚等）看的是公开抓取数据、按平台单独收费且不能绑定本人后台。
- **核心取舍（调研后的结论）**：
  1. **截图识别是通用基线**，三平台一期全靠它。原因：小红书没有创作者数据 API；抖音 / 快手 API 需审核、审核周期与结果不可控，不能作为上线前提。
  2. **官方 OAuth API 是增强通道**，抖音优先（文档最全、token 生命周期清晰），快手其次，按阶段接入。
  3. **绝不爬虫、绝不模拟登录、绝不用第三方转售接口**。三平台用户协议均明令禁止，且有 490 万 / 500 万判赔与刑事判例（见 RESEARCH §4）。这是硬红线，写进 out-of-scope。

## 2. 范围

### in-scope
1. **平台适配层**：统一的「规范指标模型」+ `PlatformAdapter` 接口，一期实现抖音、小红书、快手三个适配器；新平台只需新增一个适配器目录，不改核心。
2. **三种数据来源（source）**，按阶段落地：
   - `screenshot`：用户上传创作者后台截图（多张），视觉大模型识别为结构化 JSON，用户校对后入库。阶段 1。
   - `export`：导入平台后台导出的 Excel / CSV（抖音网页版创作者中心、小红书创作者中心均有导出）。阶段 2。
   - `api`：官方 OAuth 授权后定时拉取。抖音阶段 3，快手阶段 4。
3. **分析引擎**：确定性指标计算（增长率、互动率、作品分布、趋势斜率、异常点）+ LLM 生成叙述（状况 / 趋势 / 总结 / 注意事项），叙述只能引用已计算的数字。
4. **报告**：单账号报告、跨平台对比报告；页面查看 + 导出 Markdown / PDF。
5. **数据留痕**：每个入库数字都能追溯到来源（哪张截图 / 哪个 API 响应 / 哪个导出文件），以及识别模型与 prompt 版本。
6. **多账号**：本人可绑定多个平台账号（同平台多个也可），单用户登录。

### out-of-scope（明确不做）
- **任何形式的爬虫、模拟登录、逆向 App 接口、Cookie 代登录、购买第三方转售数据**。
- 监测**他人**账号 / 公开榜单 / 爆款库 / 达人库（那是新榜、蝉妈妈的生意，且数据来源不合规）。
- 直播数据、电商 / 带货 GMV、收入分析（一期不做；模型预留 `live` / `revenue` 指标域但不实现）。
- 内容生产（文案、标题、脚本生成）。
- 自动发布 / 定时发布 / 评论回复。
- 多用户 / 多租户 / 团队权限 / 计费：本项目是**本人自用**，只有一个登录身份。
- 自托管、Docker、常驻 worker 进程：所有后台任务走 Vercel Cron + Route Handler。
- 移动端 App（Web 响应式即可，手机浏览器能用）。
- 粉丝画像的截图识别（性别 / 年龄 / 地域饼图）——一期只识别数字型指标，图表型页面阶段 2 再评估。

## 3. 设计约定（被验收标准引用）

### 3.1 规范指标模型（canonical metrics）

所有来源的数据最终落到同一套指标名。适配器负责「平台名词 → 规范名」映射与单位归一。

| 规范名 | 含义 | 抖音叫法 | 小红书叫法 | 快手叫法 |
|---|---|---|---|---|
| `followers` | 粉丝总数 | 粉丝 | 粉丝 | 粉丝 |
| `followers_delta` | 期间涨粉（可负） | 涨粉 / 净增粉丝 | 新增粉丝 − 流失粉丝 | 涨粉 |
| `views` | 播放 / 阅读 | 播放量 | 观看 / 阅读 | 播放量 |
| `likes` | 点赞 | 点赞 | 点赞 | 点赞 |
| `comments` | 评论 | 评论 | 评论 | 评论 |
| `shares` | 分享 / 转发 | 分享 | 分享 | 分享 |
| `favorites` | 收藏 | 收藏 | 收藏 | 收藏 |
| `completion_rate` | 完播率（0–1） | 完播率 | — | 完播率 |
| `ctr` | 点击率 / 封面点击率（0–1） | — | 点击率 | — |
| `posts_count` | 期间发布作品数 | 发布 | 发文 | 发布 |

- 平台没有的指标 = `null`，不是 0。
- 每个指标值携带：`value`、`source`（screenshot / export / api）、`confidence`（0–1，api/export 恒为 1）、`evidence_id`。

### 3.2 数字与单位归一规则

| 原文 | 归一值 |
|---|---|
| `1.2w` / `1.2万` / `1.2 万` | 12000 |
| `3亿` | 300000000 |
| `2.5k` / `2.5K` | 2500 |
| `1,234` | 1234 |
| `12.5%` | 0.125 |
| `—` / `--` / `暂无数据` / 空 | `null` |
| `+123` / `-45`（增量） | 123 / −45（仅用于 `*_delta`） |

归一是**纯函数**，独立于模型，有完整单元测试。模型只负责「照抄屏幕上的原文字符串」，不负责换算。

### 3.3 截图识别输出契约

模型必须按 JSON Schema 输出，核心约束：

```jsonc
{
  "platform": "douyin | xiaohongshu | kuaishou | unknown",
  "page_type": "account_overview | post_list | post_detail | fans_overview | unknown",
  "period": { "label": "近7天", "start": "2026-08-28", "end": "2026-09-03", "visible": true },
  "captured_hint": "昨日 | 2026-09-03 | null",          // 截图里能看到的「数据更新至」提示
  "metrics": [
    { "name": "views", "raw": "1.2w", "visible": true, "confidence": 0.95 },
    { "name": "completion_rate", "raw": null, "visible": false, "confidence": 1.0 }
  ],
  "posts": [ { "title": "...", "published_at_raw": "09-01", "metrics": [ ... ] } ],
  "warnings": [ "dark_mode", "cropped", "overlapping_ui" ]
}
```

- **反幻觉硬规则**：屏幕上看不到的字段必须 `visible: false, raw: null`；禁止推算、禁止补零。这一条写进 system prompt 并在评测集里专门设陷阱样本。
- `raw` 保留原文字符串，归一在服务端做（§3.2）。
- 每张截图一次调用；多张截图的合并在服务端按 `platform + page_type + period` 去重合并，冲突时取 `confidence` 高者并标记 `conflict`。

### 3.4 数据模型（表）

| 表 | 关键字段 |
|---|---|
| `account` | id, platform, handle, display_name, source_capabilities[] |
| `metric_snapshot` | id, account_id, period_start, period_end, granularity(day/7d/30d/total), captured_at, source, metrics jsonb, evidence_id |
| `post` | id, account_id, platform_post_id?, title, published_at, latest_metrics jsonb |
| `post_metric_snapshot` | post_id, captured_at, source, metrics jsonb, evidence_id |
| `evidence` | id, kind(screenshot/export/api), file_ref, raw_extraction jsonb, model, prompt_version, created_at |
| `oauth_token` | account_id, platform, access_token(加密), refresh_token(加密), expires_at, refresh_count |
| `report` | id, account_ids[], period, computed_stats jsonb, narrative jsonb, model, created_at |

- 同一 `account + period + granularity` 允许多条快照（不同 `captured_at`），报告默认取最新；用于对比「同一区间不同时间看到的数字」。
- 所有删除为软删除；`evidence` 永不物理删除（合规追溯）。

### 3.5 分析引擎分层

1. **计算层（确定性，可单测）**：输入快照序列，输出 `computed_stats`：
   - 期间增长：`followers_delta`、`views` 环比（本期 / 上期 − 1）。
   - 互动率：`(likes + comments + shares + favorites) / views`，按平台分别算，不跨平台混算。
   - 作品分布：中位数、P90、爆款阈值（> 中位数 × 5）、爆款数。
   - 趋势：对日粒度序列做线性回归，输出斜率与 R²；样本 < 5 点则标 `insufficient_data`。
   - 异常：单日值超过 30 日均值 ± 3σ 标 `anomaly`。
   - 跨平台：同一规范指标并列，不做「谁更好」的加权总分。
2. **叙述层（LLM）**：输入 `computed_stats` JSON + 平台注意事项知识（§3.6），输出四段：`current_status` / `trend` / `summary` / `cautions`。
   - 每句涉及数字的话必须带 `[stat:<key>]` 引用标记，服务端校验引用的 key 存在于 `computed_stats`，否则整段重生成（最多 2 次），仍失败则返回计算层结果 + 「叙述生成失败」。
   - 输出加显式「AI 生成」标识（《人工智能生成合成内容标识办法》2025-09-01 施行）。

### 3.6 「注意事项」知识来源

不靠模型自由发挥，用一份版本化的 `platform-notes.yaml` 维护每平台的规则性提示（例：小红书粉丝 < 50 看不到详细数据；抖音 token 最长 195 天需重新授权；快手 access_token 1 小时过期）。LLM 只能从该文件选择性引用，报告里标出引用条目 id。

## 4. 分阶段实施计划

> 每个阶段 = 本阶段做什么 · 验收（可 pass/fail）· 进入下一阶段的条件。阶段之间不并行开工，前一阶段验收未过不进入下一阶段。

### 阶段 0：契约与骨架（约 1 周）

**做什么**
- 新建仓库 `creator-insight`，单个 Next.js 15（App Router、TypeScript）应用，按目录分层：`src/core`（规范指标模型、归一函数、`PlatformAdapter` 接口、分析计算层）、`src/adapters/{douyin,xiaohongshu,kuaishou}`（一期只放指标映射表与 page_type 枚举）、`src/vision`（`VisionExtractor` 接口 + Qwen3-VL 实现）。
- Vercel 项目：关联 GitHub 仓库，Preview / Production 两环境；Region 选 `hkg1`（香港），离百炼与本人最近。
- 数据库：Neon Postgres（Vercel Marketplace 集成），Drizzle ORM；schema（§3.4）+ 迁移；本地开发连 Neon dev branch，不装本地数据库。
- 对象存储：Vercel Blob（私有访问），存截图原图与导出文件。
- 归一函数（§3.2）全量单元测试（Vitest）。
- `platform-notes.yaml` 初版（每平台 ≥ 5 条，含来源 URL）。

**验收**
- [ ] `pnpm test` 全绿，归一函数覆盖 §3.2 表格每一行 + 边界（`0`、`1.0w`、`12.50%`、全角数字）。
- [ ] 三个适配器都实现 `PlatformAdapter` 接口且通过同一套契约测试（映射表无遗漏规范名、无未知规范名）。
- [ ] `pnpm db:migrate` 对 Neon dev branch 一次成功；对 Production branch 通过 Vercel build 时的迁移步骤成功。
- [ ] `git push` 后 Vercel Preview 自动部署成功，首页可访问；Production 部署成功且已绑定自定义域名。

**进入下一阶段条件**：以上全过 + 用户确认 §3.1 指标表与 §3.4 数据模型。

### 阶段 1：截图通道 MVP（约 3 周）

**做什么**
- 上传：一次拖入 1–20 张截图（png / jpg / webp，单张 ≤ 10 MB），浏览器直传 Vercel Blob（client upload，绕过 4.5 MB 函数请求体限制），服务端 pHash 去重（汉明距离 ≤ 5 视为重复）。
- 识别：`VisionExtractor` 接口，唯一必选实现为 Qwen3-VL（百炼 DashScope 兼容接口），按 §3.3 schema 输出；每张截图一个 Route Handler 调用（`maxDuration` 设 60 s），前端并发 ≤ 3 张，失败重试 1 次。
- 校对页：识别结果按截图逐张展示，原图与字段并排；`confidence < 0.8` 或 `warnings` 非空的字段高亮；用户可改任意字段；**未经用户点「确认入库」不写 `metric_snapshot`**。
- 入库：合并多张截图（§3.3 合并规则）→ 归一 → 写快照 + evidence。
- 看板：单账号「最新快照」卡片 + 近 30 天粉丝 / 播放折线（仅当已有 ≥ 2 个快照）。
- 评测集：每平台 ≥ 30 张真实截图（含深色模式 ≥ 5、裁剪不全 ≥ 3、有「—」空值 ≥ 3），人工标注真值，脚本化跑准确率。

**验收**
- [ ] 评测集上，`visible: true` 字段的**归一后数值**准确率 ≥ 95%（每平台分别统计）。
- [ ] 陷阱样本（字段被裁掉 / 显示「—」）中，模型输出 `visible: false` 的比例 ≥ 98%；出现「补数字」即该样本判 fail。
- [ ] `platform` 与 `page_type` 分类准确率 ≥ 98%。
- [ ] 同一张截图上传两次，第二次提示重复且不产生新 evidence。
- [ ] 校对页改一个字段后入库，`metric_snapshot.metrics` 中该值为改后值，`evidence.raw_extraction` 仍为模型原始输出（留痕）。
- [ ] 单张截图端到端（上传 → 识别结果可见）P95 ≤ 15 s。

**进入下一阶段条件**：三平台准确率均达标 + 用户用自己的真实账号截图走完一遍流程并确认。

### 阶段 2：分析引擎 + 报告 + 导出文件导入（约 3 周）

**做什么**
- 计算层（§3.5 第 1 层）全部指标 + 单元测试（用手工构造的快照序列验证每个公式）。
- 叙述层（§3.5 第 2 层）+ 引用校验 + AI 标识。
- 报告页：单账号报告、跨平台对比报告；导出 Markdown 与 PDF（PDF 用无 headless 浏览器的方案如 `@react-pdf/renderer`，Puppeteer 在 Vercel 函数里体积与时长都不划算）。
- `export` 来源：解析抖音网页版创作者中心导出 Excel、小红书创作者中心导出表格（列名映射进适配器；快手若确认有导出再加）。
- `platform-notes.yaml` 扩到每平台 ≥ 15 条。

**验收**
- [ ] 计算层：构造 10 组已知答案的快照序列，输出与手算一致（增长率、互动率、爆款数、斜率方向、异常点）。
- [ ] 叙述层：100 次生成中，引用校验失败率 ≤ 2%，且无一次出现 `computed_stats` 中不存在的数字（人工抽检 20 份）。
- [ ] 报告显式带「AI 生成」标识；PDF 中同样可见。
- [ ] 导入抖音导出 Excel 后，快照 `source = export, confidence = 1`，字段与文件逐列一致。
- [ ] 跨平台报告中，某平台缺失的指标显示「该平台无此指标」而非 0。
- [ ] 快照 < 5 个时趋势段落显示「数据不足」而非编造趋势。

**进入下一阶段条件**：用户对报告内容做一次「有用性」评审并确认（这是主观门槛，明确写在这里而不是假装可量化）；同时抖音开放平台应用已提交审核（阶段 3 的前置依赖，审核周期不可控，需提前启动）。

### 阶段 3：抖音 OAuth API 通道（约 2 周，另加审核等待）

**做什么**
- 抖音开放平台创建应用，申请 scope：`user_info`、`fans.data`、`data.external.user`、`data.external.item`、`renew_refresh_token`（具体 scope 名以审核后台为准，见 RESEARCH §1）。
- OAuth2 授权码流程；token 加密存储；access_token 15 天 / refresh_token 30 天 / 最多刷新 5 次（单链路 ≤ 195 天）——到期前 7 天提示用户重新授权。
- 定时同步：Vercel Cron 每日触发 `GET /api/cron/sync`（带 `CRON_SECRET` 校验），拉取账号数据、粉丝数据、视频列表与单视频数据，写 `source = api` 快照；单次运行控制在 `maxDuration` 内，账号多时分页续跑。
- 同一账号同时有截图与 API 数据时，报告默认用 API，截图作为对照；差异 > 5% 标 `discrepancy`。

**验收**
- [ ] 授权一次后，连续 3 天定时任务各产生 1 条 `source = api` 的日粒度快照。
- [ ] 手动把 `expires_at` 改到过去 → 下次同步自动 refresh 成功；`refresh_count` 达 5 → 同步停止并给出「需重新授权」提示，不报错刷屏。
- [ ] 撤销授权后，系统在下次同步时把账号标为 `auth_revoked`，历史数据保留。
- [ ] 429 时按退避重试，日志可见，不丢当天任务。
- [ ] 同一天 API 与截图数据并存时，报告显示来源标签与差异标记。

**进入下一阶段条件**：以上全过 + 抖音审核通过（若审核被拒，本阶段以「mock 服务器通过全部验收」结束，并把被拒原因记入 RESEARCH，快手阶段照常进行）。

### 阶段 4：快手 API + 平台扩展 + 多账号（约 2 周）

**做什么**
- 快手开放平台入驻（需企业主体认证）、`user_info` + 视频列表接口；access_token 1 小时过期，refresh 机制。
- 新增一个平台适配器演练（候选：B 站或微信视频号，仅截图来源）以验证「兼容其他平台」的抽象真的成立。
- 本人多账号切换、账号分组、组级对比报告。

**验收**
- [ ] 快手通道通过与阶段 3 同构的 5 条验收。
- [ ] 新平台适配器从零到截图入库，**不修改 `src/core` 任何文件**（用 git diff 证明）。
- [ ] 组级报告中每个账号的指标都能点回各自的 evidence。

**下一步（阶段 4 之后，不在本 SPEC 内）**：粉丝画像图表识别、直播 / 电商域；若日后要开放给他人使用，再谈多用户、备案与计费。

## 5. 验收标准（EARS，可 pass/fail）

**数据来源与合规**
- AC-1: THE 系统 SHALL 只通过用户上传截图、用户导入导出文件、用户授权的官方 OAuth API 三种方式获取数据。 · 测法：代码审查 + 依赖清单中无任何 HTTP 抓取 / 浏览器自动化库指向平台域名；网络出站白名单只含 VLM / LLM 供应商与官方 open API 域名。
- AC-2: WHEN 用户上传截图, THE 系统 SHALL 在识别前提示「请确保截图来自你本人有权访问的账号后台」并记录同意时间。 · 测法：首次上传出现提示且 `consent_at` 落库。
- AC-3: THE 系统 SHALL 为每个入库数值保存 `evidence_id`，可从报告任一数字点回原始截图 / 文件 / API 响应。 · 测法：随机抽 10 个数字点击溯源均能打开对应 evidence。

**截图识别**
- AC-4: WHEN 一张截图中某指标不可见或显示「—」, THE 识别结果 SHALL 输出 `visible: false, raw: null`。 · 测法：陷阱样本集通过率 ≥ 98%（阶段 1 验收）。
- AC-5: WHEN 识别结果任一字段 `confidence < 0.8`, THE 校对页 SHALL 高亮该字段且默认不勾选「确认」。 · 测法：构造低置信输出，页面状态符合。
- AC-6: IF 上传图片经 pHash 判定与已有 evidence 重复, THEN THE 系统 SHALL 拒绝入库并提示重复来源。 · 测法：同图两次上传。
- AC-7: IF VLM 调用失败或超时（30 s）, THEN THE 系统 SHALL 重试 1 次，仍失败则该张截图标 `failed` 并允许单张重试，不影响同批其它截图。 · 测法：mock 供应商返回 500。
- AC-8: THE 归一函数 SHALL 对 §3.2 每一行输入返回对应输出，且对无法解析的字符串返回 `null` 并记录 `unparsed_raw`。 · 测法：单元测试。

**分析与报告**
- AC-9: WHEN 用户为某账号生成报告, THE 系统 SHALL 先输出计算层结果，再输出叙述层；叙述层失败时报告仍可查看计算层。 · 测法：mock LLM 失败。
- AC-10: THE 叙述层 SHALL 只引用 `computed_stats` 中存在的 key；引用校验失败超过 2 次则回退。 · 测法：注入含伪造数字的 LLM 输出，观察回退。
- AC-11: WHILE 某账号日粒度快照少于 5 个, THE 报告 SHALL 在趋势段显示「数据不足」且不输出斜率。 · 测法：3 个快照的账号。
- AC-12: WHERE 报告包含多个平台, THE 系统 SHALL 按规范指标并列展示，缺失指标显示「该平台无此指标」。 · 测法：抖音 + 小红书对比报告中 `completion_rate` 列。
- AC-13: THE 报告 SHALL 带可见的「AI 生成」标识（页面与 PDF）。 · 测法：肉眼核对。

**API 通道**
- AC-14: WHEN 抖音 access_token 过期, THE 同步任务 SHALL 用 refresh_token 续期后继续；WHEN `refresh_count = 5` 或 refresh 失败, THE 系统 SHALL 标记账号需重新授权并通知用户。 · 测法：阶段 3 验收 2。
- AC-15: IF 官方 API 返回 429, THEN THE 系统 SHALL 指数退避（1 s 起，最多 5 次）后重试，不丢任务。 · 测法：mock 429。
- AC-16: THE 系统 SHALL 用 AES-256-GCM 加密存储 token，日志中不出现 token 明文。 · 测法：grep 日志与 DB 明文。

**平台扩展**
- AC-17: WHEN 新增一个平台适配器, THE `src/core` SHALL 零改动。 · 测法：阶段 4 验收 2（git diff）。

**部署**
- AC-18: WHEN 推送到非 `main` 分支, THE Vercel SHALL 生成 Preview 部署；WHEN 合并到 `main`, THE Vercel SHALL 更新 Production。 · 测法：一次 PR 流程观察两个 URL。
- AC-19: THE Production 站点 SHALL 只有本人登录后可访问任何数据页；未登录访问 `/accounts/*`、`/reports/*`、`/api/*`（登录与 cron 端点除外）返回 401 / 跳转登录。 · 测法：无痕窗口逐一访问。
- AC-20: THE `/api/cron/*` 端点 SHALL 校验 `Authorization: Bearer <CRON_SECRET>`，不匹配返回 401。 · 测法：curl 无头 / 错头。

## 6. 非功能需求（NFR）

| 维度 | 要求 / 无所谓 |
|---|---|
| 性能 / 延迟 | 单张截图识别 P95 ≤ 15 s；报告生成（含 LLM）P95 ≤ 60 s；看板页 TTFB ≤ 1 s。所有长调用的 Route Handler 显式设置 `maxDuration`（≤ 所在 Vercel 计划上限）。 |
| 规模 | 本人自用：≤ 10 个账号、每日 ≤ 50 张截图、Neon 免费 / 最低档即可；不为多用户预留容量。 |
| 安全 / 鉴权 | 单人登录（Auth.js，邮箱魔法链接或 GitHub OAuth，白名单只放本人邮箱）；Vercel Blob 私有 + 短期签名 URL；token 加密（AC-16），密钥放 Vercel 环境变量；cron 端点用 `CRON_SECRET`（AC-20）。 |
| 隐私 | 截图可能含手机号、收入、私信——上传后用 VLM 同一次调用标记 `pii_regions`，展示时打码；原图默认保留 180 天后由 Vercel Cron 自动删除（evidence 元数据保留）；一键删除全部数据。数据经 Vercel（香港）与阿里云百炼处理，自用可接受。 |
| 合规 | 不爬虫（AC-1）；AI 标识（AC-13）；自用不做生成式 AI 备案；若日后开放他人使用再评估（§9）。 |
| 可访问性 | 校对页键盘可操作（Tab 跳字段、Enter 确认）；对比度符合 WCAG AA。 |
| 可观测性 | 每次 VLM / LLM 调用记录：模型、prompt 版本、token 用量、耗时、结果状态；每日汇总成本；Vercel 函数日志保留期内可查。 |
| 成本 | 截图识别单张 ≤ ¥0.05（Qwen3-VL）；报告叙述单份 ≤ ¥0.5；Vercel Hobby 计划起步，触及 Cron 频率或函数时长上限再升 Pro；月总成本目标 ≤ ¥200。 |
| 可移植性 | `VisionExtractor` / `NarrativeGenerator` 都是接口，供应商可换；Vercel 专有服务（Blob、Cron）各自封装在一个模块里，便于日后替换，但一期不为迁出 Vercel 做设计。 |

## 7. 涉及的文件与接口（新仓库，规划布局）

| 归属 | 文件 / 接口 / 表 | 改动性质 |
|---|---|---|
| `src/core` | `metrics/canonical.ts`（§3.1 枚举）、`metrics/normalize.ts`（§3.2）、`adapter/PlatformAdapter.ts`、`analysis/compute.ts`（§3.5 计算层）、`analysis/narrative.ts`（叙述层 + 引用校验） | 新建 |
| `src/adapters/douyin` | `mapping.ts`、`pageTypes.ts`、`export/parseExcel.ts`（阶段 2）、`api/oauth.ts`、`api/sync.ts`（阶段 3） | 新建 |
| `src/adapters/xiaohongshu` | `mapping.ts`、`pageTypes.ts`、`export/parseExcel.ts`（阶段 2） | 新建 |
| `src/adapters/kuaishou` | `mapping.ts`、`pageTypes.ts`、`api/*`（阶段 4） | 新建 |
| `src/vision` | `VisionExtractor.ts` 接口、`providers/qwen.ts`（默认，唯一必选）、`schema/extraction.schema.json`（§3.3）、`prompts/v1.md` | 新建 |
| `src/infra` | `blob.ts`（Vercel Blob 封装）、`db.ts`（Neon + Drizzle）、`crypto.ts`（token 加解密）、`auth.ts`（Auth.js 单人白名单） | 新建 |
| `src/app` | 页面：`/upload`、`/review/[batchId]`、`/accounts/[id]`、`/reports/[id]`、`/settings/connections`；Route Handlers：`POST /api/upload`（签发 Blob client-upload token）、`POST /api/extract`、`POST /api/snapshots/confirm`、`POST /api/reports`、`GET /api/oauth/douyin/callback`（阶段 3）、`GET /api/cron/sync`（阶段 3）、`GET /api/cron/purge-blobs` | 新建 |
| `vercel.json` | `crons`：每日 `sync`、每日 `purge-blobs`；函数 region `hkg1` | 新建 |
| DB | §3.4 七张表 + Drizzle 迁移（Neon） | 新建 |
| 配置 | `platform-notes.yaml`、`.env.example`（`DASHSCOPE_API_KEY`、`DATABASE_URL`、`BLOB_READ_WRITE_TOKEN`、`AUTH_SECRET`、`CRON_SECRET`、`TOKEN_ENC_KEY`、抖音 / 快手 app 凭据） | 新建 |
| 评测 | `eval/screenshots/{douyin,xiaohongshu,kuaishou}/*.png` + `truth.json`、`eval/run.ts`（本地跑，不部署） | 新建 |

> 顺序：先定契约（`src/core` 的指标模型、adapter 接口、extraction schema）→ vision 与页面并行 → adapters 按阶段。

## 8. 端到端验证步骤

在 **Vercel Preview 部署**上真跑（不是本地 dev server，因为要验证 Blob 直传、`maxDuration`、Cron 这些只在 Vercel 上成立的东西）：

1. 推分支 → Vercel Preview URL 打开，用本人邮箱登录；无痕窗口访问 `/accounts` 被拒（AC-19）。打开 `/upload`。
2. 用自己真实的抖音 App「创作者服务中心」截 3 张（账号概览、作品列表、一条作品详情，其中一张用深色模式），小红书创作者中心截 3 张，快手创作者中心截 3 张，一次拖入 9 张。
3. 观察每张识别结果：`platform` / `page_type` 正确；数字 `raw` 与截图一致；深色模式那张 `warnings` 含 `dark_mode`；被裁掉的字段 `visible: false`。
4. 故意把一个字段改成明显错误值再改回，点「确认入库」→ 数据库 `metric_snapshot` 出现 3 条（每平台 1 条），`evidence` 9 条。
5. 再上传其中 1 张相同截图 → 被拒绝并提示重复（AC-6）。
6. 隔天再截一次三平台概览并入库；连续 5 天后生成单账号报告：趋势段有斜率描述；第 3 天时生成应显示「数据不足」（AC-11）。
7. 生成抖音 + 小红书对比报告：`completion_rate` 在小红书列显示「该平台无此指标」；报告顶部有「AI 生成」标识；点任一数字能跳到对应截图（AC-3）。
8. 导出 PDF，标识仍可见。
9. （阶段 3 后）在 `/settings/connections` 完成抖音授权 → 次日 Vercel Cron 日志显示 `sync` 成功，看到 `source = api` 快照，与前一日截图快照并列且标出差异；手动 curl `/api/cron/sync` 不带密钥返回 401（AC-20）。
10. 从设置页「删除我的全部数据」→ Blob 中原图、快照、报告全部不可访问；`evidence` 元数据软删标记。
11. 合并到 `main` → Production 自动部署，用自定义域名重复第 1、2 步各一次。

以上全部通过 = 阶段 1–2 完成；第 9 步通过 = 阶段 3 完成。

## 9. 假设清单

### 已确认（2026-09-04）
- [x] **分析对象**：本人运营的账号（可多个），不监测他人。
- [x] **技术栈**：Next.js 单仓库，其它技术次要。
- [x] **视觉模型**：Qwen3-VL（阿里云百炼）为默认且唯一必选实现；Claude 等其它供应商不在一期范围，接口保留即可。
- [x] **部署**：仅 Vercel。

### 由上述决策派生、未单独确认（有异议改这里）
- [ ] **工作名 CreatorInsight，仓库名 `creator-insight`**；本 SPEC 暂存于 daily-brief 仓库 `docs/creator-insight/`，实现时新建独立仓库。
- [ ] **Vercel 周边选型**：数据库 Neon Postgres（Marketplace 集成）+ Drizzle；对象存储 Vercel Blob；定时任务 Vercel Cron；登录 Auth.js 单人白名单；Region `hkg1`。选它们只因为和 Vercel 零配置集成，不是技术偏好。
- [ ] **Vercel 计划**：Hobby 起步。已知约束：Cron 每天最多一次、函数时长上限较低；阶段 3 需要每日同步 + 每日清理两个 cron 时若超限升 Pro。
- [ ] **大陆访问 Vercel**：Vercel 默认域名在大陆访问不稳定；绑定自定义域名后通常可用。自用场景接受该风险，不做加速方案；若实测打不开再议。
- [ ] **叙述层 LLM**：与视觉模型同在百炼（`qwen-plus` 档），省一套鉴权与计费；同样接口化。
- [ ] **百炼接入方式**：用 DashScope 的 OpenAI 兼容端点（大陆区），从 Vercel 香港函数出网调用；实测延迟不达标再考虑百炼新加坡区。
- [ ] **合规**：自用不做生成式 AI 备案。「用户上传自己后台截图」模式调研未找到直接判例（现有判例全部针对主动抓取 / 绕过技术措施）；按「本人对自有数据行使处理权」设计，保留同意记录（AC-2）。若日后开放他人使用，先取书面法律意见。
- [ ] **抖音 / 快手 API 审核结果不可控**：阶段 3 / 4 的 API 部分若被拒，以 mock 通过验收收尾，截图 + 导出文件通道作为长期主通道。
- [ ] **快手是否有后台导出功能**：未确认；阶段 2 只做抖音、小红书导出解析。
- [ ] **截图原图保留 180 天**后由 cron 删除，evidence 元数据永久保留。
- [ ] **粉丝画像（饼图 / 柱状图）识别**不在一期；阶段 2 末评估。
- [ ] **单位归一中「w」一律按「万」处理**，不考虑英文语境的「week」歧义（创作者后台不会出现）。
