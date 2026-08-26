# daily-brief

Aggregate international tech and world news into briefs, push them to WeCom and Gmail, and commit
each issue into this repo's default branch. Run by GitHub Actions, on a schedule generated from a
config file.

Four issues a day, two kinds: a **tech brief** at 07:10 and 20:10 (WeCom + mail), and a **news
edition** at 07:40 and 19:10 that carries the three news sections only, to mail only
([docs/NEWS-EDITION.md](docs/NEWS-EDITION.md) records why they are separate issues rather than
extra sections). A weekly review goes out Monday 08:00.

- **What gets in** → `brief.config.yaml` (`sources` + `sections`)
- **Who receives it** → `brief.config.yaml` (`recipients`), plus the `RECIPIENTS_OVERRIDE_JSON` secret for private ones
- **When it goes out** → `brief.config.yaml` (`schedules`), regenerated into the workflow by `pnpm brief:schedule`
- **What was sent** → `archive/`, committed to `main` on every run

The full design record is [docs/PLAN.md](docs/PLAN.md).

---

## Quick start

```bash
pnpm install
pnpm brief --dry-run     # renders to stdout — no push, no archive, no commit
```

`--dry-run` needs no secrets at all. It fetches the real sources and prints exactly what each
recipient would have received.

## Manual setup (do this before the first real run)

None of it costs money.

### 1. Gmail App Password

Mail goes out over Gmail SMTP, not Resend: no domain needed and any recipient works.
Resend's free tier is real, but without a verified domain it can only deliver to the address that
registered the account — which breaks "recipients are configurable" the day a second one is added.

1. Turn on 2-Step Verification at [myaccount.google.com/security](https://myaccount.google.com/security).
   An App Password cannot be created without it — the page below just says "not available".
2. Go to [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords), name it
   anything (`daily-brief`), and copy the 16 letters it shows.
   **It is shown once.** Losing it means deleting that entry and creating another.
3. Save the five secrets:

| Secret       | Value                                       |
| ------------ | ------------------------------------------- |
| `SMTP_HOST`  | `smtp.gmail.com`                            |
| `SMTP_PORT`  | `465`                                       |
| `SMTP_USER`  | the Gmail address                           |
| `SMTP_PASS`  | the 16 letters, **with the spaces removed** |
| `EMAIL_FROM` | the same address as `SMTP_USER`             |

Two things that silently break this:

- **The spaces are display only.** Google prints `abcd efgh ijkl mnop` for readability; the password
  is the 16 characters without them. Pasting the spaces gives `Invalid login: 535`.
- **`EMAIL_FROM` must be `SMTP_USER`** (or an alias verified inside Gmail's settings). Gmail will not
  let you send as an arbitrary address — it either rewrites the header or rejects the message.

Limit: 500 messages per rolling 24h — a daily brief uses one. If Google ever rate-limits the
account, switch `SMTP_HOST` to QQ/163 with their authorization code; nothing else changes.

### 2. WeCom group robot

Optional — skip it and the run still succeeds, it just reports one skipped recipient every day.
(Set `enabled: false` on `me-wecom` to silence that line.)

It has to be a **WeCom** group; robots do not exist in consumer WeChat. Open the group → **⋯** →
group robots → add → create → copy the webhook URL. Save the **whole URL including `?key=...`** as
`WECOM_WEBHOOK_ME`; the key is the credential and the code never reassembles the URL.

The URL is masked to `https://qyapi.weixin.qq.com/***` everywhere it could be written down — run
summary, warnings, archive — so a public repo cannot leak it.

Limits: 20 messages/minute and **4096 bytes** (not characters — Chinese is 3 bytes each) per
markdown body. Oversized briefs are split automatically, never mid-entry, with a 3s pause between
chunks.

### 3. Actions permissions

Settings → Actions → General → **Workflow permissions** → **Read and write**. Without it the daily
archive commit fails, and the archive commit is what keeps the schedule alive (see below).

### 4. Repository secrets

| Name                                                                                                           | Required | Purpose                                                                     |
| -------------------------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------- |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS`                                                                | **yes**  | Gmail SMTP; `SMTP_PASS` is the App Password                                 |
| `EMAIL_FROM`                                                                                                   | **yes**  | usually the same as `SMTP_USER`                                             |
| `EMAIL_TO`                                                                                                     | no       | the `To:` address; unset means the email recipient is skipped               |
| `EMAIL_CC`                                                                                                     | no       | the `Cc:` list, as a JSON array or `a,b`                                    |
| `WECOM_WEBHOOK_ME`                                                                                             | no       | WeCom group-robot webhook, full URL; omit it and that recipient is skipped  |
| `RECIPIENTS_OVERRIDE_JSON`                                                                                     | no       | private recipients that must not be committed                               |
| `SERVERCHAN_KEY` `PUSHPLUS_TOKEN` `WXPUSHER_APP_TOKEN` `WXPUSHER_UIDS` `TELEGRAM_BOT_TOKEN` `TELEGRAM_CHAT_ID` | no       | only if you enable those channels                                           |
| `RESEND_API_KEY`                                                                                               | no       | only with a verified custom domain                                          |
| `LLM_API_KEY`                                                                                                  | no       | turns on LLM summaries; unset means every item keeps its source excerpt     |
| `LLM_BASE_URL`                                                                                                 | no       | any OpenAI-compatible endpoint, overriding the one in the config            |
| `LLM_MODEL`                                                                                                    | no       | the model name, overriding the one in the config; moves with `LLM_BASE_URL` |
| `GITHUB_TOKEN`                                                                                                 | auto     | raises the GitHub search rate limit and makes the archive commit            |

A `secretRef` pointing at an unset variable **skips that recipient** and says so in the run
summary. It does not fail the run, and it does not affect anybody else.

### Who gets the mail

One `channel: email` entry sends **one** message, and two secrets decide its headers.
No address is committed:

```
EMAIL_TO = you@example.com
EMAIL_CC = ["a@example.com", "b@example.com"]
```

`EMAIL_TO` is the `To:` header — normally one address, though a list works there too.
`EMAIL_CC` is the `Cc:` header, and takes either a JSON array or a plain `a,b` list;
`EMAIL_TO` accepts both shapes as well. An address already in `To:` is not copied again,
and with nothing to copy the `Cc:` header is omitted rather than sent empty.

Both replace the config's `to` / `cc` outright when set, rather than adding to them — so
changing who gets the brief means editing a secret, never the YAML. Both are treated as
secret values and masked out of anything the run commits.

While `EMAIL_TO` is unset the email recipient is **skipped** with `missing env: EMAIL_TO`
in the run summary, exactly like an unset webhook on any other channel — the run itself
still succeeds. A malformed secret is different: it fails immediately at startup, naming
the secret, rather than surfacing hours later inside the mailer.

Everyone on the message sees everyone else — there is no BCC, and no per-address
`sections`. If a second address needs its own sections, its own format, or its own line in
the run summary, give it a second recipient entry with a different `id` and its own `to`.
`RECIPIENTS_OVERRIDE_JSON` is merged by `id` and can carry one privately:

```json
[{ "id": "work-mail", "channel": "email", "driver": "smtp", "to": ["work@example.com"] }]
```

No extra secret is needed for any of this: every address reuses the same `SMTP_*` /
`EMAIL_FROM` credentials, and one bad address fails the whole message, so check for typos.

## The first run

Actions → **daily-brief** → `Run workflow ▾`. Do it twice.

**Pass 1 — tick `render only`.** That checkbox is `--dry-run`: it fetches, ranks and renders, then
prints to the log. Nothing is mailed, nothing is archived, nothing is committed. It proves the
Actions environment itself works — lockfile installs, the sources are reachable from GitHub's
network, rendering does not throw — before a half-broken issue can be archived and have its items
consumed by cross-day dedupe.

**Pass 2 — leave every field at its default.** This is the real one: it delivers, archives, and
commits.

> **`render only` does not check your secrets.** Under `--dry-run` every recipient is rerouted to
> the stdout channel, so it is stdout's (empty) requirements that get checked, not the real
> channel's — see [`src/channels/index.ts`](src/channels/index.ts). A missing `SMTP_PASS` shows up
> in pass 2, never in pass 1.

## Reading a run

Open the run and read the **Summary**, not just the checkmark.

| Section  | What it should say                                                     |
| -------- | ---------------------------------------------------------------------- |
| 抓取     | every source succeeded; a failed one is a warning, not a stopped brief |
| 推送     | one row per recipient — `sent` / `skipped` / `failed`                  |
| sections | the items that went out, each with its `rankScore`                     |
| 告警     | absent on a healthy run                                                |

The 抓取 table's **最新** column is the age of that source's newest item. It is there because a row
of all-✅ only proves the requests worked: a feed can answer 200 with a well-formed body and no new
content for months. When that age passes the source's `staleAfterDays` budget (default 30), 告警
says so — see [docs/SOURCES.md](docs/SOURCES.md#9-源健康检查).

**A green check does not mean it was delivered.** `skipped` is a success for the job: one recipient
missing its secret must not take down the others. Only `failed` turns the run red. So the 推送 table
is the only place that tells you whether mail actually left.

Then confirm the two things the Summary cannot show you:

- the mail arrived — **check the spam folder first**, a new sender talking to itself often lands there
- `main` gained a `chore(daily-brief): archive <date>` commit, authored by `github-actions[bot]`

**No items means no delivery.** A brief with nothing in it is not pushed, not archived and not
committed — only noted in the Summary. So "the run was green and I got nothing" is worth checking
against the Summary before assuming a broken pipe.

### When something goes wrong

| Symptom                         | Cause                                     | Fix                                                    |
| ------------------------------- | ----------------------------------------- | ------------------------------------------------------ |
| `skipped — missing env: X`      | secret absent, or the name is misspelled  | names are case-sensitive and exact                     |
| `failed — Invalid login: 535`   | App Password wrong, or pasted with spaces | regenerate, strip spaces                               |
| `failed — errcode 93000`        | WeCom webhook revoked or robot deleted    | copy the whole URL again                               |
| `sent` but nothing in the inbox | spam filter                               | mark as not-spam                                       |
| `commit archive` step red       | Actions has no write permission           | Workflow permissions → Read and write                  |
| everything green, no content    | nothing passed the filters                | check 抓取 for a dead source, or widen `lookbackHours` |

Content that was produced but not delivered is already archived — fix the cause and replay it with
the `from-archive` input (`YYYY-MM-DD`) instead of re-fetching.

## Browsing the archive

Every archived issue is also published as a static site on GitHub Pages:
`https://<user>.github.io/daily-brief/` — an index of all issues with instant search, one page
per issue, `latest.html` as a stable bookmark, and `feed.xml` for a reader.

One-time setup: **Settings → Pages → Build and deployment → Source → GitHub Actions.**
No secrets, no branch, no extra commits — the site is uploaded as an artifact.

The site rebuilds on three triggers, and the middle one is the important one:

| Trigger                         | Covers                                       |
| ------------------------------- | -------------------------------------------- |
| `push` to `main` (paths)        | edits to the site code, templates, or config |
| `workflow_run` of `daily-brief` | the daily archive commit                     |
| `workflow_dispatch`             | manual rebuild                               |

> **A `push` trigger alone would never fire for the daily issue.** The archive is committed by
> `github-actions[bot]` with `GITHUB_TOKEN`, and pushes made with that token do not start
> workflow runs. That is why `pages.yml` also listens for `daily-brief` completing — and why its
> checkout pins `ref: main`, since a `workflow_run` event reports the SHA from _before_ the
> archive commit.

Preview it locally — relative links mean `file://` works:

```bash
pnpm site:build
start site/index.html    # macOS/Linux: open site/index.html
```

`site/` is gitignored. It is a derived view of `archive/**/*.json`; delete it any time.
Design notes and the rejected alternatives are in [docs/PAGES.md](docs/PAGES.md).

## Everyday tasks

### Add a source

Add six lines to `sources:`, list it in a section. No TypeScript changes.

```yaml
sources:
  - name: cloudflare-blog
    type: rss
    weight: 1.0
    params: { url: https://blog.cloudflare.com/rss/ }
```

Three source types cover everything: `rss` (any feed, including GitHub Releases `.atom`),
`hackernews` (Algolia API, free and unauthenticated) and `github` (repository search — GitHub has
no Trending API and this never scrapes the HTML page).

Two things to check before you commit it: that the URL returns XML rather than an SPA's HTML shell
(that is how 36氪's official feed died), and how often the source actually publishes. Anything
slower than monthly needs `staleAfterDays`, or the health check will report it as stale every day.
The full inventory — every source, its measured cadence, and the ones deliberately left out — is
[docs/SOURCES.md](docs/SOURCES.md).

### Clean up a source's boilerplate

Feeds glue fixed noise onto every entry: `点击查看原文`, a bare `Comments`, `The post … appeared
first on The GitHub Blog`, a ` - thepaper.cn` suffix, a newsletter pitch in front of the actual
sentence. `stripPatterns` is a list of case-insensitive regexes removed from the **title and the
excerpt** before anything else runs, and an invalid regex fails config load rather than the 07:10
run.

```yaml
sources:
  - name: infoq-cn
    type: rss
    stripPatterns: ['点击查看原文>?']
    params: { url: https://www.infoq.cn/feed }
```

An excerpt that was nothing but boilerplate ends up absent rather than empty, which is the honest
answer — that source has no readable summary to give, and no regex can invent one.

Two related knobs sit next to it. `render.excerptMaxChars` (default 300) is the character budget,
and the excerpt is cut at the last full sentence that fits inside it rather than mid-word.
`dedupe.titleSimilarity` (default 0.2) catches the same story rewritten by a second outlet — the
Dice coefficient over character 4-grams of the normalized title. Both defaults were measured
against real archived issues; the reasoning is in the comments in `brief.config.yaml`, and
`stripPatterns` has to run first or a shared source suffix scores higher than a real cross-post.

### Turn on LLM summaries

Every item can carry a model-written `summary` alongside the source's own `excerpt`. The
excerpt is never overwritten — the renderers print `summary ?? excerpt`, so with no model
configured the brief looks exactly as it did before.

Sections and sources that set `fetchFullText: true` have the linked article fetched and
read before the model sees it, so the summary describes the piece rather than rephrasing
the feed's teaser. A page that cannot be read — a paywall, a JS-only shell, a 403 — falls
back to the excerpt and the item is summarized anyway; the run page reports `正文抓取 N/M`.

Nothing happens until you set the key. `llm.enabled: true` is already in the config, and
with `LLM_API_KEY` unset the stage skips itself and leaves one line on the Actions run page.
Add the secret and it starts working, no config edit:

```
LLM_API_KEY   any OpenAI-compatible key         → summaries start appearing
LLM_BASE_URL  optional secret;   overrides llm.provider.baseUrl
LLM_MODEL     optional variable; overrides llm.provider.model
LLM_CONCURRENCY  optional variable; overrides llm.provider.concurrency (1-16)
LLM_ENABLED   optional variable; "false" stops the calls without a config edit
```

The config ships pointing at DeepSeek, but nothing in the code knows that: the client is one
POST to `/chat/completions` with a bearer key, not a vendor SDK. Moving to another
OpenAI-compatible vendor is three settings and no code change —

```
LLM_API_KEY  = the new vendor's key      (secret)
LLM_BASE_URL = https://api.example/v1    (secret — the path can carry auth)
LLM_MODEL    = the new model name        (variable — not sensitive)
```

Change `LLM_BASE_URL` and `LLM_MODEL` **together**: a new endpoint still being asked for
the previous vendor's model name answers 404 every morning. Both default to whatever
`llm.provider` says, so the committed config stays the readable record while the secrets
carry the swap. The model that actually ran is recorded per item in `summaryMeta.model` and on the run-summary row, so
an archive from before a swap still says which model wrote it. Two things to re-check after
moving vendor: the endpoint must accept `max_tokens` and `temperature: 0`, and the prompt
asks for JSON — verify with `pnpm brief --dry-run` before letting it run at 07:10.

`LLM_CONCURRENCY` rides along because a rate limit belongs to the key, not to the config: a
free tier at roughly 1 QPS answers `concurrency: 4` with a wall of 429s. That makes an
A/B against an archived issue a single command, no config edit and nothing sent —

```
LLM_API_KEY=<the free key> LLM_BASE_URL=https://open.bigmodel.cn/api/paas/v4 LLM_MODEL=glm-4.7-flash LLM_CONCURRENCY=1 pnpm brief --re-enrich 2026-08-26 --diff
```

Anything a vendor adds beyond the OpenAI shape — thinking mode, tools — goes in
`llm.provider.extraBody` and is merged into the request body verbatim. Tool calling is
already standard `tools` / `tool_choice` across vendors; thinking mode is where each writes
its own parameters, which is what that field exists for:

```yaml
extraBody: { thinking: { type: enabled }, reasoning_effort: low } # DeepSeek
extraBody: { enable_thinking: true, thinking_budget: 2048 } # Qwen
```

The config rejects `model`, `messages`, `temperature`, `max_tokens` and `stream` there — the
first four are the provider block's own, and an SSE body would read as "non-JSON" and drop
every item back to its excerpt. Turning thinking on also means raising `maxOutputTokens`
well past 300: the chain of thought is billed and counted as output, so a model can spend
the whole budget thinking and have none left to answer with.

Who gets summarized is a whitelist, decided in two independent steps:

```yaml
llm:
  sections:
    tech: { summarize: true } # "is this KIND of content worth paying for"
  sources:
    gh-trending-ts: { summarize: false } # source beats section
  when:
    excerptShorterThan: 80 # "is THIS item's own excerpt already good enough"
    topPerSection: 3
```

Both must say yes. The switches are the editorial judgement; `when` is the per-item quality
check. A source override beats its section, which beats `llm.defaults` — and a field the
override leaves out defers to the layer below rather than resetting it.

See the plan before spending anything:

```bash
pnpm brief --dry-run --llm-dry-run   # lists the items it would call on, and the token estimate
```

That estimate is a promise: the same gates decide the real run, so the count matches. On a
typical morning after the boilerplate cleanup, 3 of the 22 selected items pass — most feed
excerpts are already good enough, which is the point of the second gate.

Failure is never fatal. A dead endpoint, a rejected key, a timeout, or a reply that will not
parse all degrade that one item back to its excerpt, record a warning, and leave the exit
code at `0`. `pnpm brief --no-llm` skips the stage entirely.

Two things are enforced rather than requested, because the output is committed to a public
repo and mailed without review: the feed text is fenced and declared untrusted in the prompt,
and every answer is stripped of links, HTML, control and bidi characters before it is used.
Links in the brief come from `item.url`, never from the model.

### Give the mail more than the phone gets

Once the summaries are real, one document no longer suits both surfaces: mail has no length
ceiling, WeCom caps a message at 4096 **bytes** and a Chinese character costs three of them.
`recipients[].detail` splits them.

```yaml
recipients:
  - id: me-mail
    channel: email
    detail: full # headline + summary + bullets + the source excerpt, folded away
  - id: me-wecom
    channel: wecom
    detail: compact # headline + one sentence; the detail is what the mail is for
```

Leave it out and it follows the channel: mail and stdout read in full, every push channel
(WeCom, Telegram, ServerChan, PushPlus, WxPusher) gets the short copy — a push is a nudge,
not the read. An explicit value always wins. How short "short" is comes from
`render.compactMaxChars` (default 100), spent down to the last whole sentence that fits, the
same way excerpts are. Measured on a real 22-item issue with full-length summaries on every
entry: `full` is 14.3 KB (4 WeCom messages), `compact` is 7.6 KB (2).

### The whole-issue 导读

`llm.digest` is one extra call, made after the items are summarized and fed only with what the
run already produced — so it introduces the issue the reader is actually getting rather than the
feeds it was assembled from. It opens the mail (`position: bottom` moves it under the sections),
and unlike takeaways it is kept in the `compact` copy too: three sentences on what today is about
is exactly what tells you whether to open the mail at all.

`sentences` is what the prompt asks for; `maxChars` is what the sanitizer enforces. If the call
fails there is simply no 导读 that morning — every item still carries its own summary, and the
exit code never hears about it.

### The weekly review

```bash
pnpm brief --weekly              # the last weekly.days of archived issues
pnpm brief --weekly 2026-08-20   # …ending on a given date, to rebuild a missed Monday
```

It reads `archive/`, re-ranks what is in there by the `rankScore` each morning already computed,
and keeps `weekly.limitPerSection` per section. **It fetches nothing**: every item is already in the
archive under its own day, summaries included, so the only model call it can ever make is the one
whole-week 导读 (`weekly.digest` × `llm.digest.enabled`).

It **is** archived, like every other issue that goes out, under its own slot:

```
archive/2026/08/2026-08-24.json          Monday's brief
archive/2026/08/2026-08-24.weekly.json   Monday's review, beside it
```

The items in it are reprints, but the 本周导读 is written once and exists nowhere else — dropping the
file would throw that away, and §3.5's rule is that the archive holds what was sent. It also puts
the review on the static site, and makes the Monday run produce its own archive commit.

The price of that copy is one rule: **anything reconstructing "what was published on day X" must
skip the `weekly` slot** (`isReprint` in [src/archive/paths.ts](src/archive/paths.ts)). Two readers
do — cross-day dedupe, which would otherwise stretch its window by `weekly.days`, and the next
review, which would otherwise keep re-promoting its own picks. The site and `index.md` deliberately
do not: there, a reprint is a page you want.

It is configured under a top-level `weekly:` block rather than as a `schedules[]` entry — a schedule
means "go and fetch", and the lookback window, the cross-day dedupe and the archive write all exist
to serve that. `weekly.recipients` defaults to nobody and must be named explicitly: a weekly review
is a read, not something that should land on a phone at 08:00 on a Monday. Its cron is generated
from `weekday` + `time` like every other one, so `pnpm brief:schedule` after changing either.

### Iterate on the prompt without waiting for tomorrow

```bash
pnpm brief --re-enrich 2026-08-21 --diff
```

Re-summarizes an archived issue and prints the old excerpt next to the new summary. It fetches
no feeds and **writes nothing** — a delivered issue stays what it was. This is why `summaryMeta`
records the model and `promptVersion`: it tells "the model changed its mind" apart from "I
changed the instructions". Bump `PROMPT_VERSION` in `src/enrich/prompt.ts` whenever you edit
the prompt.

One caveat: issues archived before the boilerplate cleanup still have `Comments` and
`appeared first on …` sitting in their excerpts, so replaying them feeds the model dirty input.
Compare against a recent issue instead.

### Retire a section without deleting it

Set `enabled: false` on the section. Its sources stay declared and keep validating, they are simply
never fetched, and the health check stops reporting them. Turning it back on is one line and needs
no cron regeneration. `recipients[].enabled` and `schedules[].enabled` work the same way, and like
those, a disabled section is skipped even when `--sections` names it explicitly.

### Change the delivery time

```bash
# 1. edit schedules[].time in brief.config.yaml
pnpm brief:schedule        # 2. regenerate the workflow cron
git commit -am "chore: brief now goes out at 07:00"   # 3. commit BOTH files together
```

Actions crons are UTC literals in the workflow YAML — the `on:` block cannot read a config file, an
env var or a repo variable. So the config stays the source of truth and the cron is generated from
it. `pnpm check:schedule` fails CI if you edit the time and forget to regenerate, which is the
difference between finding out at commit time and finding out on the morning nothing arrives.

The trigger is `07:10`, and that number is doing two jobs. Actions schedules routinely run 5–30
minutes late, so the brief lands by roughly 07:35 at worst — early enough that the summary stages
planned in [docs/LLM-SUMMARY.md](docs/LLM-SUMMARY.md) can add their 1–3 minutes without pushing
delivery past breakfast. And `:10` is deliberate: `:00` and `:30` are the two most congested
minutes in GitHub's scheduler, and the old cron sat on `:00`. `lookbackHours` covers the whole
window either way, so a skipped run loses no content.

If you set `timezone` to a zone with daylight saving, the generator prints a warning and annotates
the workflow — a fixed UTC cron is one hour wrong for half the year.

### The full schedule

Five issues go out, listed in the order they arrive. Times are `Asia/Shanghai` (the config's
`timezone`); the cron column is the UTC literal generated into
[`.github/workflows/daily-brief.yml`](.github/workflows/daily-brief.yml) — never hand-edited.

| id        | time (CST) | cron (UTC)    | frequency | `lookbackHours` | sections                                  | recipients |
| --------- | ---------- | ------------- | --------- | --------------: | ----------------------------------------- | ---------- |
| `morning` | 07:10      | `10 23 * * *` | daily     |              24 | tech · ai · cn-tech · security · releases | all        |
| `news-am` | 07:40      | `40 23 * * *` | daily     |              24 | news · cn-news · cn-life                  | mail only  |
| `news-pm` | 19:10      | `10 11 * * *` | daily     |              12 | news · cn-news · cn-life                  | mail only  |
| `evening` | 20:10      | `10 12 * * *` | daily     |              13 | tech · ai · cn-tech · security · releases | all        |
| `weekly`  | Mon 08:00  | `0 0 * * 1`   | Mondays   |      `days: 7`¹ | tech · ai · cn-tech · security · releases | mail only  |

¹ `weekly` reads the archive rather than fetching, so it takes `days` instead of `lookbackHours`.
The `morning` and `news-am` crons carry a `(previous UTC day)` annotation in the workflow: 07:10 and
07:40 CST are 23:10 and 23:40 UTC the day before.

Four of the five are defined under `schedules[]` in
[`brief.config.yaml`](brief.config.yaml); `weekly` has its own top-level `weekly:` block because it
is built from the archive rather than from a fetch — same three steps to change either.

**Why these minutes.** Every trigger avoids `:00` and `:30`, the two most congested minutes in
GitHub's scheduler. Actions routinely fires 5–30 minutes late, so read each row as "no earlier
than" — the 07:10 issue lands by roughly 07:35 at worst.

**Why these hours.** All five now fall inside DeepSeek's off-peak window (peak is UTC 01:00–04:00
and 06:00–10:00, weekdays only — 09:00–12:00 and 14:00–18:00 CST), so LLM tokens bill at half
price. `news-am` moved from 09:10 to 07:40 on 2026-08-26 for reading habits; the discount came
along for free. See [docs/LLM-VENDOR-CHOICE.md](docs/LLM-VENDOR-CHOICE.md) §4.1 before changing a
time — that is the property a cron edit silently breaks.

**Why the windows differ.** `evening` takes `lookbackHours: 13` rather than 24 — cross-day dedupe
would drop this morning's items anyway, but the shorter window means they are never fetched or
summarised twice in the first place. `news-pm` takes 12 for the same reason, which reaches back to
07:10 and so covers the 07:40 issue with half an hour to spare; `news-am` keeps 24 so that a
skipped evening run still leaves the next morning covering the full day.

`morning` and `news-am` are only 30 minutes apart, which is safe: their section whitelists do not
overlap at all, and the workflow's `concurrency` group queues rather than cancels, so a late run
makes the next one wait instead of losing it.

Publishing to Notion / 掘金 runs on its own crons in
[`.github/workflows/publish.yml`](.github/workflows/publish.yml), deliberately decoupled from when
the brief finishes:

| id       | time (CST) | cron (UTC)    | frequency | reads                            |
| -------- | ---------- | ------------- | --------- | -------------------------------- |
| `daily`  | 21:30      | `30 13 * * *` | daily     | that day's `morning` + `evening` |
| `weekly` | Mon 10:30  | `30 2 * * 1`  | Mondays   | that Monday's `weekly` issue     |

`daily` must sit after `evening` at 20:10 — at 09:30 the day's evening issue does not exist yet,
and merging the two slots would silently degrade to half a brief.

The two lists of sections are whitelists on both sides, not one whitelist and one catch-all. That
is deliberate: `sections: ['*']` on the tech issues would fetch every news source four times a
day, and the same wildcard on `weekly` would bury a week of tech in seven days of politics. A new
section is therefore invisible until some schedule names it — which is the right default for a
file that decides what goes out.

Adding another is the same three steps: a `schedules[]` entry, `pnpm brief:schedule`, commit.
GitHub reports which cron fired via `github.event.schedule`; the CLI reverse-looks-up the matching
schedule and uses its `sections` / `recipients` / `lookbackHours`. An unrecognised cron is an
error, never a guess. Two schedules at the same time is also an error — the reverse lookup would be
ambiguous. With more than one schedule live, archive filenames gain a slot suffix
(`2026-08-20.morning.md`), and the pre-slot files already in `archive/` keep working:
`--from-archive` falls back to the unsuffixed name.

### Re-send a past issue

```bash
pnpm brief --from-archive 2026-08-20
```

Fetches nothing — it replays the archived JSON. Useful when the content was produced but delivery
failed, which is exactly the case the pipeline order is designed for.

### Run one recipient or one section

```bash
pnpm brief --dry-run --sections tech --recipients me-wecom
```

## How it works

```
loadConfig ─┬─ readArchive(last 14 days) ────────────┐  (cross-day dedupe set)
            ├─ fetch(sources) concurrently → normalize ┴─→ dedupe
            │     └─ a source that fails records a warning; the brief still goes out
            ├─ filter (keywords / score floor / time window) → rank → truncate per section
            ├─ enrich (fetch article → LLM summary, opt-in per section/source) ← AFTER selection
            │     └─ any failure degrades that item to its excerpt; exitCode stays 0
            ├─ writeArchive (md + json + rebuilt index.md)      ← BEFORE delivery
            ├─ render once per (sections, format, detail) signature
            ├─ deliver concurrently, each recipient in its own try/catch
            └─ commit archive, write $GITHUB_STEP_SUMMARY
```

**Archiving happens before pushing, deliberately.** WeCom or Gmail can fail; the content should not
disappear with them. When delivery fails the job fails and the alert fires, but the issue is already
in the repo and `--from-archive` can resend it.

**The LLM runs after selection, not before.** Two reasons, both structural. `section.limit`
already caps how many items exist by then, so the token bill has a ceiling that no configuration
mistake can lift. And `filter` matches `include`/`exclude` against `title + excerpt` — summarizing
first would silently drift those rules with no error to show for it. Running after selection also
means the summaries land in the archive, so the static site, `--from-archive` and any future digest
inherit them for free.

**Nothing to say means nothing is sent.** A brief with zero qualifying items is not pushed and not
archived — only recorded in the step summary. A daily empty email trains you to ignore the real one.

**Ranking is pure code, no LLM.** `rankScore = sourceWeight × (0.6 × percentile-within-source +
0.4 × recency)`, plus `minPerSource` so one high-volume source cannot eat a section. Deterministic,
fully unit-tested, no API key and no quota. The archive stores the raw items, so an LLM summary
layer could later be replayed over history without re-fetching.

**The archive is also the state.** Cross-day dedupe reads the last 14 days of archived JSON — there
is no second state file to drift out of sync. That check runs on canonical URL, then exact title,
then near-identical title, so a story rewritten by a second outlet does not spend two seats in one
section. Titles whose numbers disagree are never merged: `Rust 1.98.0` and `Rust 1.99.0` read
alike and are not the same release.

**The daily archive commit is what keeps the schedule alive.** GitHub disables scheduled workflows
in a public repo after 60 days of inactivity, and only commits on the _default branch_ count. One
commit a day resets that timer with 60× headroom. This is why the archive goes to `main` and not to
a side branch.

**Nothing secret reaches the archive.** This repo is public. Warnings are redacted twice before
being written: by exact value for everything read from env, and by shape for webhook URLs, bot
tokens and API-key patterns that an upstream might echo back.

## Publishing to Notion / 掘金

Optional, off until you configure it. The brief keeps working exactly as before whether
this is set up or not — publishing is a separate workflow with its own cron, its own
alert wording, and its own secrets. Full design: [docs/PUBLISH.md](docs/PUBLISH.md).

**What it does.** At a fixed local time (`daily` 09:30, `weekly` Mon 10:30) it reads the
archive — never the network, never the model — rebuilds one article out of a window of
archived issues, and posts it. Two rules shape the content:

- **only tech goes out.** `publish.include` is a whitelist; a section added later is not
  published until someone names it there.
- **one day is merged, not one issue.** The daily line reads that day's `morning` _and_
  `evening`, which is what takes it from ~13 items to ~29.

Re-running is safe: the state file records a `contentHash` and a second run is a no-op.

### Setup

| #   | Do this                                                                                                                                                               | Where it ends up                                                                        |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | Create a Notion integration                                                                                                                                           | its token → secret `NOTION_TOKEN`                                                       |
| 2   | Create a Notion database with six columns, named exactly `Name` (title) · `Date` (date) · `Line` (select) · `Summary` (text) · `Tags` (multi-select) · `Source` (url) | —                                                                                       |
| 3   | Database `…` menu → **Connections** → add the integration                                                                                                             | **the step everyone forgets**; skipping it answers `object_not_found`                   |
| 4   | Copy the 32-hex id out of the database URL                                                                                                                            | secret `NOTION_DATA_SOURCE_ID` (a database id works too — it is resolved)               |
| 5   | 掘金 → write-article page → F12 Network → filter `article_draft` → save a draft → read the payload                                                                    | `category_id` / `tag_ids` → `brief.config.yaml`, with the Chinese name in a comment     |
| 6   | Copy that request's whole Cookie header                                                                                                                               | secret `JUEJIN_COOKIE` — **secrets only**, never the config, the logs or the state file |
| 7   | Repo variable `PUBLISH_ENABLED=true`                                                                                                                                  | the break-glass switch: set it to `false` to stop publishing without a PR               |
| 8   | _(trial period)_ Settings → Environments → `publishing` → required reviewer = you                                                                                     | the manual gate for stage A                                                             |

Nothing above is required to start: a target whose secret is unset is **skipped**, not
failed, so you can configure Notion first and leave 掘金 for later.

`pnpm publish:run --validate-only` prints which targets are ready and which secrets are
still missing.

### Trial period, then automatic

掘金 starts at `autoPublish: false` — it only ever creates a **draft**, which you open in
the 草稿箱 and look at. Flip it to `true` after ten consecutive issues with no formatting
surprises and no cookie expiry. Markdown dialect problems are only visible in the real
editor, and the cost of looking is one glance a day.

Once automatic, three passive guards replace the manual one: `minItems` (too few items →
no post at all), `failStreakLimit` (three consecutive failures → circuit opens, no more
requests, alert fires), and `PUBLISH_ENABLED=false`.

### Everyday tasks

```bash
# see exactly what would go out, and why — calls no platform
pnpm publish:dry --schedule daily --date 2026-08-22

# publish one line to one target by hand
pnpm publish:run --schedule weekly --targets notion-archive

# re-publish after fixing something the hash would otherwise call "unchanged"
pnpm publish:run --schedule daily --force

# check what is configured and which secrets are missing
pnpm publish:run --validate-only
```

`--explain` prints the selection table: what each archived issue contributed, what the
whitelist blocked, what earlier publications already used, and what the cap cut. It is
the answer to "why did today only have nine items".

### Caveats worth knowing

- **掘金 has no official publishing API.** This drives the endpoints its own web editor
  calls, with a session cookie that expires in roughly a month. When it does, the run
  fails and the alert says "Cookie 已过期" — renew the secret. Nothing else breaks: the
  mail, the archive and the Pages site are untouched.
- **Notion updates properties only.** Rewriting a page body means deleting its blocks one
  at a time, and a failure halfway leaves half a page. Content that changed after
  publication says so in the run summary instead.
- **A 掘金 post that is already public is never silently edited.** The people who read it
  will not be told, so the run warns and leaves it alone.

## Commands

| Command                                              | What it does                                                              |
| ---------------------------------------------------- | ------------------------------------------------------------------------- |
| `pnpm brief`                                         | build and deliver                                                         |
| `pnpm brief --dry-run`                               | render to stdout; no push, no archive, no commit                          |
| `pnpm brief --llm-dry-run`                           | list the items the LLM would be called on, and call nothing               |
| `pnpm brief --no-llm`                                | skip the LLM stage; every item keeps its source excerpt                   |
| `pnpm brief --re-enrich <date> --diff`               | re-summarize an archived issue to evaluate a prompt change                |
| `pnpm brief --weekly [<date>]`                       | weekly review out of the archive — fetches nothing, archived as `.weekly` |
| `pnpm publish:run --schedule daily`                  | cross-post the day window to the configured targets                       |
| `pnpm publish:dry`                                   | select + render + explain, calling no platform at all                     |
| `pnpm brief:schedule`                                | regenerate daily-brief.yml cron from the config                           |
| `pnpm publish:schedule`                              | regenerate publish.yml cron from the config                               |
| `pnpm check:schedule`                                | fail if EITHER workflow and the config disagree                           |
| `pnpm validate`                                      | validate the config and exit                                              |
| `pnpm site:build`                                    | compile `archive/` into the static site under `site/`                     |
| `pnpm test`                                          | vitest (pure functions only — no network, no SMTP, no temp files)         |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck` | the rest of CI                                                            |

## Layout

```
brief.config.yaml            the only file you normally edit
.github/workflows/
  daily-brief.yml            cron block generated by pnpm brief:schedule
  publish.yml                cron block generated by pnpm publish:schedule
  pages.yml                  build archive/ into a site and deploy it to GitHub Pages
  ci.yml                     lint / format / typecheck / test / validate / check:schedule
archive/YYYY/MM/             one .md + one .json per issue, plus index.md
                             and one .publish.json per publication DAY
src/
  config/      zod schema + loader; invalid config fails the run
  sources/     rss | hackernews | github, fetch injected for tests
  core/        normalize, dedupe, filter, rank, chunk, redact, pipeline
  schedule/    timezone → UTC cron, reverse lookup, drift guard
  enrich/      policy (pure) | prompt | llm client | sanitize | replay
  render/      markdown | html | text
  archive/     read/write, fs injected for tests
  channels/    wecom, email, serverchan, pushplus, wxpusher, telegram, stdout
  publish/     collect (window -> issue) | adapt | state | notion | juejin | stdout
  site/        archive/**/*.json -> static site (see docs/PAGES.md)
```

Adding a channel is one file, one registry line, and one boundary table in `test/`.
Adding a publishing platform is the same shape — see `src/publish/` and docs/PUBLISH.md §1.1.
