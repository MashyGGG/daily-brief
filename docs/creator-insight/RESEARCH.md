# CreatorInsight 调研与方案过程记录

> 日期：2026-09-04。配套规格：[SPEC.md](./SPEC.md)。
> 本文记录「需求 → 调研 → 分析 → 方案决策」全过程与来源，供日后回溯为什么这样定。价格、审核门槛类信息以当日检索为准，落地前需再核一次官网。

## 0. 原始需求（用户原话要点）

- 新项目、新仓库，数据分析平台。
- 结合抖音、小红书、快手等平台的用户数据，分析当前状况、趋势、总结说明、注意事项。
- 一期支持抖音、小红书、快手，需兼容其他平台。
- 能调平台 API 最好；没有 API 就支持用户上传多张截图，AI 识别后再分析。
- 要求检索各平台相关信息、深入分析、给详细方案，并在本地留一份过程文档。
- 补充：方案分阶段实现，每阶段写清内容、验收、下一步。
- 用户对首版 SPEC 的确认（2026-09-04）：分析对象是本人；技术栈 Next.js + Vercel 部署，其它技术次要；视觉模型默认 Qwen3-VL（大陆直连）；仅部署在 Vercel。

## 1. 调研方法

五个并行检索线程（各自限定输出格式：事实 + 来源 URL，不下结论），主线程汇总分析：

| 线程 | 问题 |
|---|---|
| 抖音开放平台 | 有没有创作者数据 API、资质、scope、token 生命周期、频控、协议 |
| 快手开放平台 | 同上 |
| 小红书 | 有没有任何第三方可用的数据通道、判例、后台字段 |
| 截图识别 | 视觉大模型 / OCR 候选、价格、大陆可用性、已知坑、后台字段清单 |
| 合规与竞品 | 法规要点、判例、竞品功能与定价 |

## 2. 平台数据通道调研结果

### 2.1 抖音

| 项 | 结论 | 来源 |
|---|---|---|
| 入口 | open.douyin.com / developer.open-douyin.com | https://open.douyin.com/platform/resource/docs/accession-guide/platform-introduction/ |
| 资质 | 企业、个体户、个人均可入驻，个人权限受限；先实名，再创建应用提交审核 | https://developer.open-douyin.com/docs/resource/zh-CN/developer/join/join-into-developer-platform |
| 用户信息 | 「获取用户公开信息」scope `user_info`，只返回**授权用户本人** | https://open.douyin.com/platform/resource/docs/openapi/account-management/get-account-open-info/ |
| 粉丝数据 | 粉丝列表、粉丝画像（性别 / 年龄 / 地域）、粉丝来源、粉丝喜好、粉丝热评 | https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/list |
| 视频数据 | 查询视频基础信息、视频分享结果及数据 | 同上 |
| scope 名（非官方汇总） | `user_info`、`fans.data`、`data.external.user`、`data.external.item`、`renew_refresh_token` | https://blog.csdn.net/nongcunqq/article/details/109448841 |
| 授权 | OAuth2 授权码 | https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/account-permission/get-access-token |
| access_token | 15 天（1,296,000 s） | 同上 |
| refresh_token | 30 天，最多连续刷新 5 次，之后需重新授权；单链路最长约 195 天 | https://developer.open-douyin.com/docs/resource/zh-CN/dop/develop/openapi/account-permission/refresh-token/ |
| 频控 | 默认 50 QPS，超出 429 | https://www.jzl.com/news/204 |
| MCN 通道 | 巨量星图，机构需 ≥ 5 个 10 万粉达人 + 2 万保证金；撮合服务商注册资本 ≥ 100 万 | https://www.xingtu.cn/help-center/mcn/109107 |
| 协议 | 用户协议明禁爬虫、模拟下载、深度链接等，且禁止把未授权获取的数据用于统计播放量、点击率等 | https://www.douyin.com/draft/douyin_agreement/douyin_agreement_user.html |
| 未找到 | 近 7 / 15 / 30 天趋势专用接口；企业 vs 个人的数据权限差异表；开发者协议原文 | — |

### 2.2 快手

| 项 | 结论 | 来源 |
|---|---|---|
| 入口 | open.kuaishou.com | https://open.kuaishou.com/ |
| 资质 | 入驻 + 主体认证，企业需营业执照、法人身份证；审核 1–7 个工作日 | https://open.kuaishou.com/docs/introduction/quickStartGuide/registrationProcess/develop.html |
| scope | `user_base`、`user_info`、`user_video_live`、`relation` | https://github.com/KwaiVideoTeam/kuaishou-liveopen-api/blob/master/doc/快手授权和鉴权服务说明.md |
| 用户信息 | GetUserInfo 返回粉丝数、关注数、昵称、头像 | https://open.kuaishou.com/platformDocs/openAbility/openAbility/userInformation/publicInformation |
| 视频数据 | 「查询用户视频列表」cursor 分页、count ≤ 200，含播放 / 点赞 / 评论 | https://s.apifox.cn/apidoc/docs-site/462993/api-7075082 |
| 授权 | OAuth2 授权码；access_token **1 小时**；refresh_token 续期 | 上述 GitHub 文档 |
| 粉丝画像 API | 未找到面向第三方的接口，仅创作者本人后台可看 | https://cp.kuaishou.com/statistics/user/fans |
| 频控 | 未找到官方数值 | — |
| 协议 | 小程序平台协议：未经同意不得收集、抓取、处理用户数据；AI 开放平台协议禁自动化程序 / 爬虫 | https://open.kuaishou.com/docs/operate/platformAgreement/agreement.html |
| 未找到 | 个人开发者能否申请数据类 API；直播数据接口官方原文；磁力聚星数据 API |  — |

### 2.3 小红书

| 项 | 结论 | 来源 |
|---|---|---|
| 开放平台 | open.xiaohongshu.com / ark.xiaohongshu.com 面向电商商家与 ISV，接口是商品 / 订单 / 库存 / 物流 | https://open.xiaohongshu.com/document/developer/file/38 |
| 蒲公英 | 面向品牌方与服务商的商业合作平台，有数据看板，但**未找到可申请的粉丝 / 笔记数据 API 官方文档** | https://pgy.xiaohongshu.com/help/docs?id=3065&userType=2 |
| 创作者数据 API | **未找到**任何面向创作者或 ISV 的 OAuth 数据接口 | https://open.xiaohongshu.com/document/api |
| 官方渠道 | App「创作者中心」；网页版创作者中心「数据概览」有**导出数据**入口（笔记曝光 / 观看 / 点赞等表格） | https://www.jzl.com/news/xhs-data-7 |
| 门槛 | 粉丝 ≥ 50 才能看详细数据看板 | https://yx.jiayisiyu.com/blog/post/29288.html |
| 后台字段 | 账号概览：观看、互动、涨粉、发文活跃度；笔记数据：近 7 / 30 日观看、互动、转化率、点击率；粉丝数据：新增、流失、互动粉丝 | https://zhuanlan.zhihu.com/p/649232843 等 |
| 规范 | 《服务市场管理规范》：开放平台未开放接口时用爬虫收集数据 → 限制功能 / 下架 / 清退 | https://xiaohongshu.apifox.cn/doc-2811123 |
| 判例 | 见 §4 |  |

### 2.4 三平台对比与推论

| | 抖音 | 快手 | 小红书 |
|---|---|---|---|
| 创作者数据 API | 有，需应用审核 | 有（基础），需企业认证 | **没有** |
| 只能取本人数据 | 是（官方明确） | 未明确，推断是 | — |
| token 生命周期 | 15 天 / 30 天 / 5 次 | 1 小时 / refresh | — |
| 后台导出文件 | 网页版可导 Excel | 未确认 | 可导表格 |
| 截图 | 可 | 可 | 可 |

**推论**：三平台唯一都能覆盖、且不依赖审核结果的通道是「截图」和「导出文件」；API 只能是增强。任何以 API 为上线前提的计划都会被小红书卡死、被抖音 / 快手审核周期拖死。

## 3. 截图识别方案调研

### 3.1 候选模型

| 候选 | 中文 UI OCR | 结构化输出 | 大陆直连 | 私有化 | 价格参考 | 来源 |
|---|---|---|---|---|---|---|
| Qwen3-VL / Qwen-VL-OCR（阿里云百炼） | 强，32 语种，低光 / 倾斜鲁棒 | 支持 JSON | 是 | 开源可部署（3B 可 Ollama 跑） | 百炼具体单价未找到 | https://help.aliyun.com/zh/model-studio/qwen-vl-ocr |
| GLM-4.5V（智谱） | 网页截图转结构化 | 支持 | 是 | 开源 | 输入 ¥2 / M、输出 ¥6 / M | https://docs.bigmodel.cn/cn/guide/models/vlm/glm-4.5v |
| Claude（Anthropic） | 强 | JSON Schema 结构化输出 | 否（需中转） | 否 | 约 $0.005 / 图（2000×2000，Sonnet 档） | https://cloudprice.net/models/anthropic-claude-4-5-sonnet |
| GPT-4o / GPT-5 | 强 | 支持 | 否（需中转） | 否 | 按 token | https://developers.openai.com/api/docs/models/gpt-4o |
| 豆包视觉 | 支持 | 支持 | 是 | 未找到 | 视觉模型单价未找到 | https://explinks.com/blog/ua-doubao-image-api-price-analysis/ |
| DeepSeek-OCR | 强，近 100 语种 | 需自己拼 | 自部署 | 开源，vLLM | 无托管定价 | https://blog.frognew.com/2025/10/deepseek-ocr-vllm-deploy.html |
| PaddleOCR 3.0 / PP-StructureV3 | 中文精度提升 13 pt | 输出 Markdown / 表格 | 自部署 | 开源 | 免费 | https://pypi.org/project/paddleocr/3.0.3/ |
| 百度 OCR | 通用高精度 | 无语义 | 是 | 否 | ¥0.005 / 次 | https://cloud.baidu.com/product-price/ocr.html |

补充（来自 claude-api 技能，2026-06 缓存）：Claude 当前默认型号为 `claude-opus-5`（$5 / $25 per M），`claude-sonnet-5`（$2 / $10）；结构化输出用 `output_config.format`；批量接口半价；图片按 token 计。若走 Claude，视觉抽取用 Sonnet 5 + 批量即可满足 NFR 成本线。

### 3.2 决策：VLM 而非纯 OCR

- 纯 OCR 只给文字，不知道「1.2w」旁边那个标签是「播放」还是「点赞」，页面布局三平台各异且常改版，规则解析维护成本高。
- VLM 一次调用同时做：平台识别、页面类型识别、字段—数值配对、可见性判断、警告标记。
- 代价是幻觉风险，用「只抄原文 + 必须声明 visible + 陷阱评测集 + 人工校对页」四道闸对冲（SPEC §3.3、阶段 1 验收）。
- 用户已确认 Qwen3-VL 为默认且唯一必选实现（大陆直连是决定性因素）；`VisionExtractor` 仍保留为接口，但一期不实现第二家供应商。

### 3.3 已知坑与对策

| 坑 | 对策 |
|---|---|
| 深色模式降低识别率（OCR 训练集偏浅底） | 评测集专门放 ≥ 5 张；输出 `warnings: dark_mode`；必要时服务端先做反色预处理 |
| 单位换算 `1.2w / 万 / 亿 / k` | 模型只抄原文，换算在纯函数里，单测覆盖 |
| 模型补数字（幻觉） | `visible` 硬规则 + 陷阱样本 + 校对页 |
| 裁剪不全 / 弹窗遮挡 | `warnings: cropped / overlapping_ui`，字段置 `visible: false` |
| 日期范围（「近 7 天」到底是哪 7 天） | 取截图内「数据更新至」提示；没有则按上传日推算并标 `period.visible: false` |
| 多图重复 | pHash 去重 |
| 同一区间多张图数字不一致 | 按 confidence 取高，标 `conflict`，校对页让用户裁决 |

（「专门针对创作者后台截图解析」的公开开源项目未找到，需自建评测集。）

### 3.4 后台字段清单（用于 extraction schema）

- 抖音 App 创作者服务中心：昨日播放、点赞、评论、分享、涨粉、完播率；网页版 creator.douyin.com 分作品分析 / 粉丝分析 / 收入分析 / 图文数据，可导出 Excel。
- 小红书创作者中心：账号总览（粉丝、获赞与收藏、关注）；单篇笔记（阅读、点赞、收藏、评论、分享）；粉丝画像（性别 / 年龄 / 地域 / 活跃度）。
- 快手创作者中心：总播放、总点赞、总评论；单视频播放 / 点赞 / 评论 / 分享 / 完播率；粉丝性别 / 年龄 / 地域 / 活跃时段。

## 4. 合规调研

### 4.1 法规要点

| 法规 | 要点 | 来源 |
|---|---|---|
| 《网络数据安全管理条例》2025-01-01 施行 | 个人信息处理规则告知、转移请求、大型平台责任、跨境情形 | https://www.cac.gov.cn/2024-09/30/c_1729384452307680.htm |
| 《个人信息保护法》 | 处理前告知 + 单独同意；出境需评估 / 认证 / 标准合同 | https://www.moj.gov.cn/pub/sfbgw/flfggz/flfggzbmgz/202306/t20230620_481044.html |
| 《生成式 AI 服务管理暂行办法》2023-08-15 | 具舆论属性或社会动员能力的服务需算法备案 | https://www.cac.gov.cn/2023-07/13/c_1690898327029107.htm |
| 《AI 生成合成内容标识办法》2025-09-01 施行 | 生成内容需显式 + 隐式标识 | https://www.cac.gov.cn/2025-03/14/c_1743654685899683.htm |

### 4.2 判例

| 案 | 要点 | 来源 |
|---|---|---|
| 抖音诉刷宝 | 搬运数据集合构成不正当竞争，判赔 500 万 | https://finance.sina.cn/2023-03-22/detail-imymsuqf9704954.d.html |
| 小红书诉蝉妈妈关联公司（2022 起诉，2025 终审） | 更换 ID / IP 绕过技术措施抓取，判赔 490 万 + 删数据 + 声明 | https://news.qq.com/rain/a/20250427A0580800 |
| 微博诉蚁坊 | 抓取后台数据被认定不正当，判赔 500 万 + 28 万 | https://zhuanlan.zhihu.com/p/547560082 |
| 小红书 App 加密算法被破解案 | 刑事，3 人获刑，非法获利 650 万 | https://www.xhby.net/content/s67d1318de4b097009664bbdf.html |
| 魔蝎科技 | 用户授权爬虫本身不是定罪点，**非法留存 2000 万条账号密码**才是 | https://www.secrss.com/articles/30543 |

### 4.3 结论与空白

- 「主动抓取 / 绕过技术措施」= 高确定性违法，不做。
- 「用户上传自己后台截图」：**未找到直接判例或监管定性**。按「用户对自有数据行使处理权、平台作为受托处理者」设计，保留同意记录、不留存账号密码、不代登录。这是本方案最大的合规空白点，对外前应取得书面法律意见（SPEC §9）。
- 自用 / 小范围先不备案；若面向公众提供，评估生成式 AI 备案与算法备案。
- AI 生成的报告必须带标识（SPEC AC-13）。

## 5. 竞品参照

| 平台 | 覆盖 | 功能 | 价格 | 绑定本人后台 | 来源 |
|---|---|---|---|---|---|
| 新榜 / 新视 | 公众号、抖音、小红书、快手、B 站、微博 | 账号诊断、作品追踪、评论分析、变现服务 | 799 / 1099 元 / 月 | 未找到 | https://www.newrank.cn/article/detail/30133 |
| 蝉妈妈 | 抖音短视频 / 直播电商 | 拆视频、榜单、爆款库、达人库、AI 诊断 | 398 元 / 季 – 5299 元 / 月 | 未找到 | https://www.chanmama.com/vip/ |
| 灰豚 | 淘宝、抖音、快手、小红书 | 999 万账号、榜单 | 各平台分开卖，几百到数万 | 未找到 | https://zhuanlan.zhihu.com/p/415277459 |
| 飞瓜 | 抖音（另有快手、B 站版） | 关注 10–200 个他人账号监测 | 399 – 4399 元 / 月 | 否（监测他人公开账号） | https://dy.feigua.cn/Home/Price |
| 千瓜 | 小红书 | 达人 / 笔记 / 直播 / 品牌投放 / 舆情 | 1599 / 2599 元 / 月 | 未找到 | https://www.qian-gua.com/Home/AllPrice |
| 新红 | 小红书 | 账号监控、榜单、爆款、热词 | 未找到 | 未找到 | https://www.niaogebiji.com/article-151233-1.html |

**差异化定位**：竞品全是「看别人 + 抓公开数据 + 按平台收费」，而且数据来源正被平台起诉。本项目是「看自己 + 用户自有数据 + 跨平台一张报告」，正好是空档，且合规风险结构性更低。

**分析维度参照**（竞品报告常见）：粉丝画像（人口 / 兴趣 / 消费）、涨粉四阶段（冷启动 / 加速 / 稳定 / 成熟）、爆款分析、账号诊断。一期取其中能从本人后台数据算出来的：增长、互动率、作品分布、趋势、异常；画像与阶段判定留到有画像数据后。

## 6. 方案决策汇总

| 决策 | 选择 | 排除项与理由 |
|---|---|---|
| 数据通道优先级 | 截图 → 导出文件 → 官方 API | 爬虫：违法 + 判例；第三方转售 API：来源不可证 |
| 平台兼容 | `PlatformAdapter` + 规范指标模型，新平台零改核心 | 每平台写死一套字段：三平台已经口径不一，第四个进来就崩 |
| 识别技术 | VLM + JSON Schema + 纯函数归一 | 纯 OCR + 规则：布局改版即失效 |
| 视觉模型 | Qwen3-VL（百炼）唯一必选，接口化（用户确认） | Claude / GPT：大陆需中转，Vercel 香港函数出网也不稳；一期不做第二家 |
| 分析 | 确定性计算层 + 受约束叙述层 | 让 LLM 直接看数据写报告：数字不可信、不可追溯 |
| 注意事项 | 版本化 `platform-notes.yaml` | 模型自由发挥：会编平台规则 |
| 部署 | 仅 Vercel，本人自用（用户确认） | 自托管 / Docker：多一套运维；SaaS：备案、计费、权限把一期拖成半年 |
| 技术栈 | Next.js 15 单仓库，其它选型围绕 Vercel 零配置集成（用户确认） | monorepo 拆包：单人项目没必要；Java / FastAPI 双服务：同理 |

### 6.1 「仅 Vercel」带来的架构约束与应对

| 约束 | 影响 | 应对 |
|---|---|---|
| 无常驻进程 | 不能跑 worker / 队列消费者 | 定时任务用 Vercel Cron 触发 Route Handler；每张截图一次独立函数调用，前端控制并发 |
| 函数时长上限（按计划不同） | VLM 单次调用 10–15 s，报告生成含 LLM 可能 30 s+ | 显式设 `maxDuration`；报告生成拆成「计算层同步返回 + 叙述层异步补齐」两步，避免一个函数扛全程 |
| 请求体 4.5 MB 上限 | 截图可达 10 MB | 浏览器直传 Vercel Blob（client upload），函数只收 Blob URL |
| Hobby 计划 Cron 每日一次 | 阶段 3 需要 sync + purge 两个每日任务 | 先合并到一个 cron 端点顺序执行；超时再升 Pro |
| 无本地文件系统持久化 | 截图、导出文件不能落本地盘 | 一律 Blob；评测集脚本在本地跑，不部署 |
| 大陆访问 Vercel 不稳定 | 自用时可能打不开 | 绑自定义域名；自用接受风险，不做加速 |
| 出网到百炼 | Vercel 函数在境外，调百炼大陆端点跨境 | Region 选 `hkg1` 就近；实测延迟不达标换百炼新加坡端点 |
| 数据库 | 需要 serverless 友好的 Postgres | Neon（连接池 + 分支），Drizzle ORM |

## 7. 分阶段计划（摘要，细节见 SPEC §4）

| 阶段 | 内容 | 关键验收 | 进入下一阶段 |
|---|---|---|---|
| 0 契约与骨架 | 指标模型、adapter 接口、归一函数、DB schema、Vercel 项目 + Neon + Blob 接通 | 单测全绿、三适配器过契约测试、Preview / Production 部署成功 | 用户确认指标表与数据模型 |
| 1 截图 MVP | Blob 直传、Qwen3-VL 识别、校对、入库、看板、评测集 | 数值准确率 ≥ 95%、陷阱样本 ≥ 98%、P95 ≤ 15 s | 三平台达标 + 用户真实账号走通 |
| 2 分析与报告 | 计算层、叙述层、跨平台报告、PDF、导出文件导入 | 公式手算一致、引用校验失败 ≤ 2%、AI 标识 | 用户有用性评审 + 抖音应用已提审 |
| 3 抖音 API | OAuth、token 生命周期、Vercel Cron 每日同步、来源对照 | 3 天连续快照、refresh 到 5 次正确停止、429 退避、cron 端点鉴权 | 验收全过（审核被拒则 mock 收尾） |
| 4 快手 API + 扩展 | 快手通道、第四平台演练、多账号分组 | 同构验收、core 零改动 | — |

## 8. 明确未找到 / 需人工核实

- 抖音各 scope 的官方逐条定义、趋势类接口；企业 vs 个人权限差异。
- 快手个人开发者能否申请数据类 API；用户数据 API 频控；后台是否有导出。
- 小红书任何创作者数据 API（大概率不存在）；粉丝画像是否对所有创作者开放。
- 百炼平台 Qwen-VL 逐张 / 逐 token 单价；豆包视觉单价。
- 竞品价格部分来自搜索摘要，千瓜年费数字疑似解析错误。
- 「用户上传自有截图」模式的法律定性。
- Vercel 当前计划（Hobby / Pro）的函数 `maxDuration` 与 Cron 频率上限具体数值，开工时以 Vercel 文档为准。
- 百炼 DashScope 大陆端点从 Vercel `hkg1` 出网的实际延迟与稳定性，阶段 1 实测。
