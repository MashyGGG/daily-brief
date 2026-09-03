# SPEC: 美食素材库（FoodVault）— 目录规范 + 自动归档 CLI

> 状态：草稿，待用户确认 §7。落盘日期 2026-09-03。
> 本 SPEC 是 single source of truth；需求变更改这里，不在代码里偷改。

## 1. 需求与动机

- **用户故事**：As a 美食内容创作者（单人），I want 一套按「拍摄日期」组织物理目录、按「食材」打标签检索的原始素材归档方案，so that 相机 SD 卡 / iPhone / Android 拍的原片能一条命令可靠归档到统一库，剪辑工程和成片跟原片放在一起，日后按食材快速找回复用。
- **为什么做**：素材目前散落在 SD 卡、手机相册、电脑桌面，找旧素材靠记忆；没有去重和校验，删卡不敢删；NAS 还没买，需要先把「规范 + 工具」立起来，NAS 到位后只换根路径。

## 2. 范围

### in-scope
1. **目录规范**（§3.1）：日期目录 + `raw/project/export` 子目录 + 每日 `meta.yaml`。
2. **CLI 工具 `vault`**（§3.2）：`init` / `import` / `tag` / `find` / `verify` / `ingredients` 六个子命令。
3. **三种导入来源**：相机 SD 卡（DCIM）、iPhone 导出目录、Android 导出目录，以及兜底的 `_inbox/` 目录。
4. **去重与校验**：内容哈希去重，复制后逐文件校验，可重复执行（幂等）。
5. **两阶段落地**：阶段 A 在本地硬盘目录验证；阶段 B 切到 NAS 共享目录，只改配置里的根路径。
6. NAS 选型建议（附录 A，仅建议，不是验收项）。

### out-of-scope（明确不做）
- Web 界面、缩略图 / 预览、视频转码或代理文件生成。
- AI 自动识别食材、自动打标签。
- 云盘同步 / 异地备份（但目录结构必须能被 Hyper Backup / rclone 直接整目录同步，见 NFR）。
- 多用户、账号、权限、审计。
- 在 NAS 上运行脚本（Docker / 任务计划）；本期脚本只在 Windows 电脑上跑。
- 自动从手机拉取（手机 → 电脑目录这一步由用户手动完成）。
- 与剪辑软件（PR / 剪映 / DaVinci）联动；`project/`、`export/` 由用户手动放置，脚本只保证目录存在。
- HEIC / HEVC 转格式（保留原格式原样归档）。
- 删除源文件（脚本永远不删 SD 卡 / 手机导出目录里的任何东西）。

## 3. 设计约定（被验收标准引用）

### 3.1 目录规范

```
<VAULT_ROOT>/                      # 阶段 A: D:\FoodVault   阶段 B: Z:\FoodVault (NAS SMB 映射盘)
├─ vault.config.yaml               # 根路径、时区、扩展名白名单、来源定义
├─ _inbox/                         # 用户手动拖文件的落点；import --source inbox 从这里取
├─ _quarantine/                    # 校验失败 / 无法判定日期的文件，按导入批次分子目录
└─ 2026/
   └─ 2026-09-03/                  # 一个拍摄日期一个目录；同一天多次拍摄共用
      ├─ meta.yaml                 # 本日元数据（食材标签、菜名、备注、导入记录、哈希清单）
      ├─ raw/
      │  ├─ camera/                # 来自 SD 卡
      │  ├─ iphone/
      │  └─ android/
      ├─ project/                  # 剪辑工程，手动放
      └─ export/                   # 成片，手动放
```

- **日期判定顺序**：EXIF `DateTimeOriginal`（照片）/ QuickTime `CreateDate`（视频）→ 文件名中的 `YYYYMMDD` → 文件修改时间。用了哪一种记进 `meta.yaml`；三者都失败的进 `_quarantine/`。
- **raw 内文件命名**：`<YYYYMMDD>_<HHMMSS>_<原文件名>`，例 `20260903_143012_C0012.MP4`。同秒同名冲突追加 `_1`、`_2`。
- **只认白名单扩展名**（配置可改）：`jpg jpeg heic png dng arw cr2 cr3 nef raf mp4 mov m4v mts`。其它文件跳过并在导入报告里列出。

### 3.2 `meta.yaml` 格式

```yaml
date: 2026-09-03
dishes: [番茄炒蛋]                 # 菜名，可多个，可空
ingredients: [番茄, 鸡蛋, 葱]      # 食材标签，自由文本，多值
notes: ""
imports:
  - at: 2026-09-03T15:02:11+08:00
    source: camera
    from: "E:\\DCIM"
    copied: 42
    skipped_duplicate: 3
    quarantined: 0
files:                              # 校验清单；verify 子命令据此比对
  raw/camera/20260903_143012_C0012.MP4:
    size: 1873920412
    xxh3: "9f1c…"
    date_from: exif
```

### 3.3 CLI 子命令

| 命令 | 作用 |
|---|---|
| `vault init <root>` | 创建 §3.1 骨架和默认 `vault.config.yaml` |
| `vault import <path> --source camera\|iphone\|android\|inbox [--ingredients a,b] [--dish x] [--dry-run]` | 从来源目录递归扫描白名单文件 → 判日期 → 哈希 → 复制到对应日期目录 → 校验 → 写 meta |
| `vault tag <date> [--ingredients a,b] [--dish x] [--notes "…"] [--replace]` | 修改某日 meta 的标签；默认追加、`--replace` 覆盖 |
| `vault find --ingredient 番茄 [--from 2026-01-01] [--to 2026-12-31] [--dish x]` | 列出匹配的日期目录，输出路径 + 菜名 + 食材 + raw 文件数 |
| `vault verify [<date>]` | 按 `files` 清单重新哈希比对，报告缺失 / 损坏 |
| `vault ingredients` | 汇总全库食材词及出现次数，用于人工规范拼写 |

## 4. 验收标准（EARS，可 pass/fail）

**导入**
- AC-1: WHEN 用户执行 `vault import <SD卡DCIM路径> --source camera`, THE vault SHALL 把每个白名单文件复制到 `<年>/<拍摄日期>/raw/camera/` 并按 §3.1 命名。 · 测法：准备含 3 个不同日期照片 + 视频的目录，导入后目录树与命名符合规范。
- AC-2: WHEN 一个文件复制完成, THE vault SHALL 对目标文件重新计算哈希并与源哈希比对，一致后才写入 `meta.yaml` 的 `files`。 · 测法：导入后 `meta.yaml` 中每个文件的哈希与 `xxhsum` 独立计算结果一致。
- AC-3: IF 目标哈希与源不一致, THEN THE vault SHALL 删除该目标文件、把源文件复制到 `_quarantine/<批次>/`，并在报告中标记。 · 测法：mock 复制过程写坏 1 字节，观察该文件进 quarantine、其余文件正常。
- AC-4: WHEN 源文件的内容哈希已存在于目标日期目录的 `files` 清单中, THE vault SHALL 跳过复制并把该文件计入 `skipped_duplicate`。 · 测法：同一 SD 卡连续导入两次，第二次 `copied=0`，目录内文件数不变。
- AC-5: WHEN 导入过程被中断（Ctrl-C / 断电）后再次执行同一命令, THE vault SHALL 完成剩余文件且不产生半截文件。 · 测法：复制到临时名 `*.part` 再重命名；中断后重跑，目录内无 `*.part`，文件数等于源文件数。
- AC-6: IF 无法从 EXIF、文件名、修改时间任一得到日期, THEN THE vault SHALL 把文件放入 `_quarantine/<批次>/` 并在报告中说明。 · 测法：构造无 EXIF、文件名无日期、mtime 被清零的文件。
- AC-7: THE vault SHALL 永不删除或移动来源路径下的任何文件。 · 测法：导入前后对源目录做文件清单 diff 为空。
- AC-8: WHERE 传入 `--dry-run`, THE vault SHALL 只打印将执行的复制 / 跳过 / 隔离计划，不写任何文件。 · 测法：dry-run 前后目标根目录 hash 树一致。
- AC-9: WHEN 导入结束, THE vault SHALL 输出一份汇总报告：复制数、跳过重复数、隔离数、非白名单跳过数、总字节数、耗时。 · 测法：肉眼核对报告数字与目录实际一致。
- AC-10: WHERE 导入命令带 `--ingredients` / `--dish`, THE vault SHALL 把标签写入所有本次涉及日期目录的 `meta.yaml`（追加去重）。 · 测法：导入跨两天素材，两个 `meta.yaml` 都含该标签。

**标签与检索**
- AC-11: WHEN 用户执行 `vault tag 2026-09-03 --ingredients 番茄,鸡蛋`, THE vault SHALL 把两个标签追加到该日 `meta.yaml`，已存在的不重复。 · 测法：执行两次，`ingredients` 长度不变。
- AC-12: WHEN 用户执行 `vault find --ingredient 番茄`, THE vault SHALL 列出所有 `ingredients` 含「番茄」的日期目录，按日期降序。 · 测法：3 个日期中 2 个含番茄，输出恰好那 2 个且顺序正确。
- AC-13: WHEN `find` 同时带 `--from/--to`, THE vault SHALL 只返回区间内（含端点）的目录。 · 测法：边界日期用例。
- AC-14: WHEN 用户执行 `vault ingredients`, THE vault SHALL 输出全库食材词及出现次数，按次数降序。 · 测法：构造「番茄」×2、「西红柿」×1，输出两行且顺序正确。

**校验**
- AC-15: WHEN 用户执行 `vault verify`, THE vault SHALL 对清单中每个文件重新哈希，报告 `ok / missing / corrupted` 三类计数并逐条列出非 ok 项。 · 测法：删 1 个、改 1 个，报告各 1。
- AC-16: IF `verify` 发现任何非 ok 项, THEN THE vault SHALL 以非零退出码结束。 · 测法：`$LASTEXITCODE -ne 0`。

**配置与迁移**
- AC-17: WHEN 用户把 `vault.config.yaml` 的 `root` 从 `D:\FoodVault` 改为 `Z:\FoodVault` 并把整棵目录复制过去, THE vault SHALL 所有子命令在新根下正常工作且 `verify` 全 ok。 · 测法：阶段 B 迁移演练（§6 第 8 步）。
- AC-18: THE vault SHALL 不在 `meta.yaml` 或任何库内文件里写绝对路径（`imports[].from` 除外，仅作记录）。 · 测法：grep 库内 yaml 无 `D:\` 前缀出现在 `files` 键中。

## 5. 非功能需求（NFR）

| 维度 | 要求 / 无所谓 |
|---|---|
| 性能 | 导入是 IO 密集；脚本自身开销（哈希 + 写 meta）不得使吞吐低于纯复制的 80%。基准：USB3 读卡器导入 50 GB ≤ 15 min。哈希用 xxh3（非加密）。 |
| 规模 | 每周新增几十 GB，按年 2–3 TB 设计；单日目录内文件数上限 5000；`meta.yaml` 单文件 < 5 MB。超过则 `find` 仍需在 2 s 内返回（全库 ≤ 1000 个日期目录）。 |
| 安全/鉴权 | 无。单人局域网。 |
| 隐私 | 无外网调用；不上传任何内容。 |
| 可访问性 | 无。CLI 输出需在 Windows Terminal 下中文不乱码（UTF-8）。 |
| 可观测性 | 每次 import 在 `<root>/_logs/YYYY-MM-DD_HHMMSS.log` 留完整日志；控制台只打进度和汇总。 |
| 可靠性 | 幂等（AC-4/5）、原子写（`.part` → rename）、`meta.yaml` 写入先写临时文件再替换。 |
| 可移植性 | 库目录能被 Synology Hyper Backup / rclone 整目录同步；不依赖 NTFS 特有属性；文件名不含 NAS/SMB 不允许字符 `\ / : * ? " < > \|`。 |
| 成本 | 本期零成本（本地硬盘）。NAS 预算见附录 A。 |

## 6. 端到端验证步骤

在 `D:\FoodVault` 阶段 A 环境真跑一遍：

1. `vault init D:\FoodVault` → 目录骨架和 `vault.config.yaml` 生成。
2. 用真实 SD 卡（含至少 2 个拍摄日的照片 + 4K 视频，≥ 5 GB）执行 `vault import E:\DCIM --source camera --dish 番茄炒蛋 --ingredients 番茄,鸡蛋 --dry-run`，核对计划无误。
3. 去掉 `--dry-run` 重跑；观察进度；结束后核对报告数字、目录结构、命名、`meta.yaml` 内容。
4. 立刻重跑同一命令 → 报告 `copied=0, skipped_duplicate=N`。
5. 从 iPhone 用数据线把当天照片复制到 `D:\FoodVault\_inbox\iphone-0903\`，执行 `vault import D:\FoodVault\_inbox\iphone-0903 --source iphone`，HEIC / MOV 归入 `raw/iphone/`。
6. `vault tag 2026-09-03 --ingredients 葱` → `meta.yaml` 出现「葱」。`vault find --ingredient 番茄` 列出 2026-09-03。`vault ingredients` 汇总正确。
7. 手动改坏一个 raw 文件的 1 字节、删除另一个 → `vault verify` 报告 corrupted=1、missing=1、退出码非零；恢复后全 ok。
8. **迁移演练**：把 `D:\FoodVault` 整目录复制到另一块盘（模拟 NAS 映射盘）`Z:\FoodVault`，改 `root`，重跑步骤 6、7 中的 `find` / `verify` → 行为一致。
9. 确认源 SD 卡和 `_inbox` 文件一个没少（AC-7）。

以上全部通过 = 阶段 A 完成。NAS 到位后重复步骤 8 即为阶段 B。

## 7. 未决假设（待确认）

- [ ] **实现语言**：Node.js + TypeScript（pnpm 单包，与现有工具链一致），依赖 `exiftool-vendored` 读元数据、`xxhash-wasm` 哈希、`yaml` 解析。若更想用 Python，改此项即可，规格不变。
- [ ] **单人、局域网、Windows 电脑运行**；不考虑 macOS 路径差异。
- [ ] **同一天多次拍摄共用一个日期目录**，靠 `dishes` 多值区分；不引入 `2026-09-03_番茄炒蛋` 这类带 slug 的目录名。
- [ ] **时区**：按运行电脑本地时区解析 EXIF 无时区时间。
- [ ] **手机导入路径**：iPhone / Android 由用户手动（数据线 / Windows 照片应用）导出到任意目录或 `_inbox/`，再执行 `import --source iphone|android`；脚本不直接读手机。
- [ ] **去重范围**：只在目标日期目录内去重（同一文件不同日期不视为重复）。
- [ ] **食材词表**：自由文本，不做同义词合并；靠 `vault ingredients` 人工统一拼写。
- [ ] **project/export 子目录**：脚本只创建，不校验、不哈希、不去重。
- [ ] **云备份**：本期不做，但目录规范已保证可整目录同步。
- [ ] **项目位置**：新仓库 `C:\other-files\food-asset-vault\`，与 daily-brief / others 无代码关系。

## 附录 A：NAS 选型建议（非验收项）

- 容量：按 2–3 TB/年 + 3 年留量 → 两盘位 RAID1 至少 2×8 TB，或四盘位留扩展。
- 候选：Synology DS224+ / DS923+（Hyper Backup 成熟，SMB 映射盘对 Windows 友好）；群晖不想要则威联通 TS-264 同档。
- 网络：千兆够用（约 110 MB/s，与 USB3 读卡器持平）；若日后剪辑直接在 NAS 上读 4K，考虑 2.5GbE。
- 与本 SPEC 的衔接：NAS 上建共享文件夹 `FoodVault` → Windows 映射为 `Z:` → 改 `vault.config.yaml` 的 `root` → 跑 §6 第 8 步。
