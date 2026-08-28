# 定时不准：实测、成因、以及能修的那部分

> 测量日期 2026-08-28。数据来自 GitHub REST `GET /repos/MashyGGG/daily-brief/actions/runs`，
> 覆盖建仓（2026-08-20）以来全部 130 次运行、其中 28 次 `schedule` 事件。
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

做法（尚未实施，等哪天真的在意准点再做）：

1. 建一个 fine-grained PAT，只授本仓 `actions: write`。
2. 把 `daily-brief.yml` 现有的 `schedule:` 全部注释掉，只留 `workflow_dispatch`
   （`workflow_dispatch` 已经支持 `schedule` 入参，反查逻辑不用改）。
3. 外部定时器（cron-job.org / Cloudflare Worker Cron / 自己机器的 crontab）按 CST 时间
   逐档调用：

   ```sh
   curl -sf -X POST \
     -H "Accept: application/vnd.github+json" \
     -H "Authorization: Bearer $GH_PAT" \
     https://api.github.com/repos/MashyGGG/daily-brief/actions/workflows/daily-brief.yml/dispatches \
     -d '{"ref":"main","inputs":{"schedule":"morning"}}'
   ```

4. 代价，三条，别忽略：
   - PAT 会过期，过期那天所有档期一起哑掉，而且**没有任何告警**——GitHub 那边看不到
     「本该有一次运行」。需要自己给外部定时器配失败通知。
   - 少了 cron 就少了「每次 push 到默认分支重置 60 天不活动计时」这层关系里的另一半；
     归档提交仍然照常，所以这条其实不受影响，但换方案时要记得确认。
   - `schedule` 事件的 `github.event.schedule` 没有了，走的是 `inputs.schedule` 分支，
     于是 §4 那个 `lastCronOccurrence` 锚点也不再生效——外部触发是准时的，本来也不需要它，
     但如果外部定时器自己迟到了，期号会重新跟着墙上时钟走。

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
