# 定时不准：实测、成因、以及能修的那部分

> 测量日期 2026-08-28，**复测 2026-09-02（见 §3.1）**。数据来自 GitHub REST
> `GET /repos/MashyGGG/daily-brief/actions/runs`，首测覆盖建仓（2026-08-20）以来 130 次
> 运行、其中 28 次 `schedule` 事件；复测覆盖 182 次运行、55 次 `schedule` 事件。
> 复现方式见本文末尾 §6。

## 1. 结论先说

**迟到发生在 GitHub 派发 `schedule` 事件的那一步，跟本仓的 workflow 无关。**

每一次定时运行的三个时间戳都长这样：

```
created_at → run_started_at    排队等 runner   0.0 min
run_started_at → updated_at    job 实际耗时    0.3–0.7 min
```

也就是说 run 一旦被创建就立刻拿到 runner、半分钟内跑完。迟到的是「run 被创建」这件事
本身。对照组同样干净：这几天里 `push` / `workflow_dispatch` / `workflow_run` 触发的运行，
排队全部是 `0.0m`，2026-08-27、08-28 这两个最糟的日子也一样。

所以下列嫌疑人全部排除：`concurrency: daily-brief` 排队、`pnpm install`、LLM enrich 阶段、
`timeout-minutes: 10`、免费额度、runner 供给。

## 2. 常态漂移：23–88 分钟，跟 UTC 小时强相关

| 档期          | cron (UTC)    | 应发 (CST) | 实际派发                      | 迟到          |
| ------------- | ------------- | ---------- | ----------------------------- | ------------- |
| morning       | `10 23 * * *` | 07:10      | 07:33–07:35                   | **23–25 min** |
| news-pm       | `10 11 * * *` | 19:10      | 19:41                         | 31 min        |
| news-pm（旧） | `10 10 * * *` | 18:10      | 18:46 / 18:50                 | 36–40 min     |
| publish daily | `30 13 * * *` | 21:30      | 22:09–22:12                   | 39–42 min     |
| evening       | `10 12 * * *` | 20:10      | 20:58 / 20:59 / 21:09 / 21:14 | **48–64 min** |
| weekly（旧）  | `0 0 * * 1`   | Mon 08:00  | 08:56                         | 56 min        |
| news-am（旧） | `10 1 * * *`  | 09:10      | 10:22 / 10:38                 | **72–88 min** |

`brief.config.yaml` 原来的判断（「避开 `:00` 和 `:30` 这两个最拥挤的分钟」）只对了一半：
避开整点分钟确实有用，但**主导变量是 UTC 小时，不是分钟**。23:xx UTC 是本仓所有档期里
最空的一档，01:10 UTC 最堵，两者差 3–4 倍。

据此做的两次调整：

- news-am 09:10 → 07:40 CST（01:10 → 23:40 UTC）。事后验证正确，漂移量降到 morning 的水平。
- weekly 08:00 → 08:20 CST（`0 0 * * 1` → `20 0 * * 1`）。`0 0` 是 GitHub 文档明确点名的
  最拥挤时刻，让开 20 分钟，送达时间几乎不变。
- evening 留在 20:10 没动：12:10 UTC 确实是日常档期里最差的，但只有 5 天数据，
  「挪到哪个小时会更好」并不成立，挪了等于换一个未验证的赌注。

原注释里的「运行 3–5min」也是高估，实测全程 0.3–0.7 分钟。

## 3. 2026-08-27 起的 5–10 小时暴走：GitHub 事故

githubstatus.com 的记录对得上（时间已转 CST）：

- `08-26 23:11` **critical · Incident with Actions** —— 数据库主库 failover、限流入站流量，`02:01` 恢复
- `08-27 06:56` minor · Actions 启动延迟，官方措辞「20% of actions runs have delayed starts」

实际派发（全部 `success`，一次没丢，只是整体后移；顺序严格保持、偏移量单调递减，
是典型的积压排空而非逐次失败）：

```
08-27 morning   12:29  (+5h19)     08-28 morning   14:54  (+7h44)
08-27 news-am   12:59  (+5h19)     08-28 news-am   15:03  (+7h23)
08-27 news-pm → 08-28 04:59 (+9h49)
08-27 evening  → 08-28 06:13 (+10h03)
08-27 publish  → 08-28 07:00 (+9h30)
```

### 3.1 复测 2026-09-02：事故过去了，延迟没有回去

事故后又跑了 5 天（08-29 ~ 09-02，44 次 `schedule` 事件，全部 `success`，一次没丢）。
**延迟没有回到常态期的水平，而是停在常态的 4–8 倍**：

| 档期          | cron (UTC)    | 常态期中位  | 事故后中位 | 倍数 |
| ------------- | ------------- | ----------- | ---------- | ---- |
| `news-am`     | `40 23 * * *` | —（旧档期） | 1h57       | —    |
| `morning`     | `10 23 * * *` | 24m         | **2h12**   | 5.5× |
| `news-pm`     | `10 11 * * *` | 36m         | **4h25**   | 7.4× |
| `evening`     | `10 12 * * *` | 59m         | **4h31**   | 4.6× |
| publish daily | `30 13 * * *` | 40m         | **4h09**   | 6.2× |

「UTC 小时是主导变量」这个判断依然成立，而且被放大了：23:xx 那两档在 2h 上下，
11:xx–13:xx 那三档在 4h 以上。实际后果是 **`evening` 现在每一期都跨到第二天凌晨**
（实测送达 00:36–03:06 CST），§4 那个期号锚定因此从「保险」变成了「刚需」。

两次调整的事后验证：`news-am` 09:10 → 07:40 **有效**（从全档期最差变成和 `morning` 同级）；
`weekly` 08:00 → 08:20 改动前后各只有 1 个样本，**判断不了**。

所以 §5 那条「离开 GitHub 调度器」不再是「哪天真的在意准点再做」——它是现在就该做的事。

## 4. 这次暴走暴露的真 bug：迟到会静默吃掉一期归档

期号日期原本取自 `new Date()`，即**运行时**而不是**应触发时**。于是 08-27 那两期迟到
10 小时的运行被写成了 08-28 的期号，而当晚 08-28 真正的 news-pm / evening 会把它们覆盖，
08-27 在归档里留一个洞。

修法：`lastCronOccurrence(cron, at)`（`src/schedule/cron.ts`）从 `github.event.schedule`
反推「这次派发属于哪一次 cron 触发」，期号日期改挂在它上面。任何小于 24 小时的延迟，
「一次 cron 触发 = 一个 (date, slot)」这个映射都是全的。

**新鲜度窗口刻意没有跟着回拨**：`now` 仍是墙上时钟，迟到的一期照样带最新的条目出去，
而不是去尊重一个已经过期的窗口。同一处修复也应用到 `publish`（发布日同样按计划触发日算，
否则 08-27 的 21:30 那条线会发成 08-28）。

被这个 bug 影响的两期已经手工归位：`2026-08-28.evening.*` / `2026-08-28.news-pm.*`
→ `2026-08-27.*`，`date` 字段同步改正，`archive/index.md` 重建。

## 5. 常态漂移能不能修：能，但得离开 GitHub 的调度器

23–88 分钟的漂移**在仓库配置层面修不掉**。GitHub 文档写明 `schedule` 是 best-effort，
高负载时会延迟甚至丢弃，免费仓库共用同一个调度队列。改 cron 只能在拥挤程度不同的时段
之间挑，挑不到「准时」。

真要准时，唯一可靠的路是**不用 GitHub 的 cron，改成外部定时器调 `workflow_dispatch`**。
本仓的数据支持这条路：事件驱动的运行即使在事故期间排队也是 `0.0m`。

### 5.1 仓库侧：已实施（2026-09-02）

两个 workflow 现在**同时接受两个触发源**，谁先到谁干活：

| 触发源                    | 传给 CLI                           | 说明                                         |
| ------------------------- | ---------------------------------- | -------------------------------------------- |
| 外部定时器（主）          | `--cron "<串>"`                    | 走 `workflow_dispatch` 的 `cron` input，准点 |
| GitHub `schedule`（兜底） | `--cron "<串>" --skip-if-archived` | 迟到几小时，发现已归档就退出                 |
| 人手点 Run workflow       | `--schedule <id>`                  | 无 cron ⇒ 无「应触发时刻」，沿用墙上时钟     |

三处改动，每一处都有它必须存在的理由：

**① `workflow_dispatch` 多一个 `cron` input。**
外部定时器传的是 **cron 串**而不是 schedule id。这样这次运行和一次准点的 `schedule`
事件完全同构：同一套档期反查、同一套 weekly 判定，以及最要紧的——同一套
`lastCronOccurrence` 期号锚定（§4）。只传 id 会走墙上时钟分支，等于把 §4 修好的
bug 重新打开：外部定时器自己迟到时，晚间那期又会写成第二天的期号。

**② `--skip-if-archived`（只加在 `schedule` 那条分支上）。**
`plannedArchive()`（`src/core/pipeline.ts`）在抓取任何源之前先算出这次运行**会写哪个文件**，
文件已存在就 exit 0。日期用的是 `run()` 那一个表达式，不是另写一份——两份实现迟早会分歧，
届时要么漏发要么重发。方向不能反：外部定时器是主、永远真跑，GitHub cron 是兜底、只补位。

**③ checkout 加 `ref: main`。**
这条最容易漏。`schedule` 事件的 `github.sha` 是**这次 run 被创建那一刻**的默认分支，而
`concurrency` 会把并发的第二次运行排队——排队那次仍然 checkout 它自己创建时的旧 SHA，
**看不到前一次刚推上去的归档**，②的检查就会失效并重复出报。`publish.yml` 早就为同一
个原因钉了 `ref: main`。顺带让跨天去重读到更新的归档，是净收益。

发布侧（`publish.yml`）只加了 `cron` input，不需要 `--skip-if-archived`：它本来就按
`contentHash` 判定，同一份内容第二次跑会自己判成 unchanged 而不重发。

### 5.2 外部侧：待配置

**第 1 步 · PAT**

GitHub → Settings → Developer settings → Personal access tokens → **Fine-grained tokens**
→ Generate new token：

- Repository access：**Only select repositories** → `MashyGGG/daily-brief`
- Permissions → Repository permissions：**只勾 `Actions: Read and write`**
  （`Metadata: Read` 会自动带上）。`Contents` 保持 **No access** —— 推归档用的是
  workflow 里的 `GITHUB_TOKEN`，不是这把 PAT
- Expiration：90 天，**记进日历**

**第 2 步 · 七条时间表**

`cron` 那一列是 **UTC**（它只是个标签，用来反查档期和应触发时刻）；
**定时器本身按 CST 那一列设时间**。

| 档期           | CST        | `cron` 值     | workflow          |
| -------------- | ---------- | ------------- | ----------------- |
| `morning`      | 07:10      | `10 23 * * *` | `daily-brief.yml` |
| `news-am`      | 07:40      | `40 23 * * *` | `daily-brief.yml` |
| `news-pm`      | 19:10      | `10 11 * * *` | `daily-brief.yml` |
| `evening`      | 20:10      | `10 12 * * *` | `daily-brief.yml` |
| `weekly`       | 周一 08:20 | `20 0 * * 1`  | `daily-brief.yml` |
| publish daily  | 21:30      | `30 13 * * *` | `publish.yml`     |
| publish weekly | 周一 10:30 | `30 2 * * 1`  | `publish.yml`     |

**第 3 步 · 调用**

```sh
curl -sf -X POST   -H "Authorization: Bearer $GH_PAT"   -H "Accept: application/vnd.github+json"   https://api.github.com/repos/MashyGGG/daily-brief/actions/workflows/daily-brief.yml/dispatches   -d '{"ref":"main","inputs":{"cron":"10 23 * * *"}}'
```

`-f` 不能省：不带它 curl 对非 2xx 也返回 0，定时器判不出失败。成功是 **204 No Content**。

### 5.3 三个代价，别忽略

1. **PAT 过期那天七条一起哑，而且没有任何告警** —— GitHub 那边看不到「本该有一次运行」。
   两道防线：定时器自己的失败通知（cron-job.org 的 Notify on failure / Worker 里 `throw`），
   以及 5.1 那条兜底 —— 最坏结果是**退回今天这个迟到几小时的状态，不是断更**。
2. **dispatches API 返回 204 不代表 run 真建起来了**（`ref` 写错、input 名不匹配都会静默
   不建）。上线当天必须回查一次 `gh run list --workflow=daily-brief.yml`。
3. `schedule:` 块**不要删**。它是兜底，也和归档提交一起维持那个 60 天不活动计时。

### 5.4 怎么验证它真的生效了

```sh
gh run list --workflow=daily-brief.yml --limit 10 --json event,createdAt,conclusion
```

`event` 应从 `schedule` 变成 `workflow_dispatch`，`createdAt` 贴着设定时间（分钟级）。
每档期会看到 **2 次运行**：1 次真跑 + 1 次几秒钟结束的跳过 —— 那是设计如此。

## 6. 复现这份测量

```sh
TOK=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')
curl -s -H "Authorization: Bearer $TOK" \
  'https://api.github.com/repos/MashyGGG/daily-brief/actions/runs?per_page=100' \
| python -c "
import json,sys,datetime
runs=json.load(sys.stdin)['workflow_runs']
cst=lambda s: datetime.datetime.strptime(s,'%Y-%m-%dT%H:%M:%SZ')+datetime.timedelta(hours=8)
for r in sorted((r for r in runs if r['event']=='schedule'), key=lambda r:r['created_at']):
    c,s,u = cst(r['created_at']), cst(r['run_started_at']), cst(r['updated_at'])
    print(f\"{r['name'][:13]:13} created={c:%m-%d %H:%M} queue={(s-c).total_seconds()/60:5.1f}m dur={(u-s).total_seconds()/60:4.1f}m {r['conclusion']}\")
"
```

`created_at` 是 GitHub 创建这次 run 的时刻，把它和 cron 的应触发时刻相减，得到的就是
§2 那一列「迟到」。`queue` 和 `dur` 两列若都接近 0，就说明问题不在你这边。
