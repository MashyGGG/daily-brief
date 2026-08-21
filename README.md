# daily-brief

Every morning, aggregate international tech + world news into one brief, push it to WeCom and
Gmail, and commit the issue into this repo's default branch. Run by GitHub Actions, on a schedule
generated from a config file.

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

| Name                                                                                                           | Required | Purpose                                                                    |
| -------------------------------------------------------------------------------------------------------------- | -------- | -------------------------------------------------------------------------- |
| `SMTP_HOST` `SMTP_PORT` `SMTP_USER` `SMTP_PASS`                                                                | **yes**  | Gmail SMTP; `SMTP_PASS` is the App Password                                |
| `EMAIL_FROM`                                                                                                   | **yes**  | usually the same as `SMTP_USER`                                            |
| `EMAIL_TO`                                                                                                     | no       | the `To:` address; unset means the email recipient is skipped              |
| `EMAIL_CC`                                                                                                     | no       | the `Cc:` list, as a JSON array or `a,b`                                   |
| `WECOM_WEBHOOK_ME`                                                                                             | no       | WeCom group-robot webhook, full URL; omit it and that recipient is skipped |
| `RECIPIENTS_OVERRIDE_JSON`                                                                                     | no       | private recipients that must not be committed                              |
| `SERVERCHAN_KEY` `PUSHPLUS_TOKEN` `WXPUSHER_APP_TOKEN` `WXPUSHER_UIDS` `TELEGRAM_BOT_TOKEN` `TELEGRAM_CHAT_ID` | no       | only if you enable those channels                                          |
| `RESEND_API_KEY`                                                                                               | no       | only with a verified custom domain                                         |
| `LLM_API_KEY`                                                                                                  | no       | turns on LLM summaries; unset means every item keeps its source excerpt    |
| `LLM_BASE_URL`                                                                                                 | no       | any OpenAI-compatible endpoint, overriding the one in the config           |
| `GITHUB_TOKEN`                                                                                                 | auto     | raises the GitHub search rate limit and makes the archive commit           |

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

Nothing happens until you set the key. `llm.enabled: true` is already in the config, and
with `LLM_API_KEY` unset the stage skips itself and leaves one line on the Actions run page.
Add the secret and it starts working, no config edit:

```
LLM_API_KEY   any OpenAI-compatible key         → summaries start appearing
LLM_BASE_URL  optional; overrides llm.provider.baseUrl
LLM_ENABLED   optional repo variable; "false" stops the calls without a config edit
```

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

### Add a second time slot

Uncomment the `evening` schedule, run `pnpm brief:schedule`, commit. GitHub reports which cron
fired via `github.event.schedule`; the CLI reverse-looks-up the matching schedule and uses its
`sections` / `recipients` / `lookbackHours`. An unrecognised cron is an error, never a guess.
With more than one schedule live, archive filenames gain a slot suffix
(`2026-08-20.morning.md`).

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
            ├─ enrich (LLM summary, opt-in per section/source)  ← AFTER selection
            │     └─ any failure degrades that item to its excerpt; exitCode stays 0
            ├─ writeArchive (md + json + rebuilt index.md)      ← BEFORE delivery
            ├─ render once per (sections, format) signature
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

## Commands

| Command                                              | What it does                                                      |
| ---------------------------------------------------- | ----------------------------------------------------------------- |
| `pnpm brief`                                         | build and deliver                                                 |
| `pnpm brief --dry-run`                               | render to stdout; no push, no archive, no commit                  |
| `pnpm brief --llm-dry-run`                           | list the items the LLM would be called on, and call nothing       |
| `pnpm brief --no-llm`                                | skip the LLM stage; every item keeps its source excerpt           |
| `pnpm brief --re-enrich <date> --diff`               | re-summarize an archived issue to evaluate a prompt change        |
| `pnpm brief:schedule`                                | regenerate the workflow cron from the config                      |
| `pnpm check:schedule`                                | fail if the workflow and the config disagree                      |
| `pnpm validate`                                      | validate the config and exit                                      |
| `pnpm site:build`                                    | compile `archive/` into the static site under `site/`             |
| `pnpm test`                                          | vitest (pure functions only — no network, no SMTP, no temp files) |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck` | the rest of CI                                                    |

## Layout

```
brief.config.yaml            the only file you normally edit
.github/workflows/
  daily-brief.yml            cron block generated by pnpm brief:schedule
  pages.yml                  build archive/ into a site and deploy it to GitHub Pages
  ci.yml                     lint / format / typecheck / test / validate / check:schedule
archive/YYYY/MM/             one .md + one .json per issue, plus index.md
src/
  config/      zod schema + loader; invalid config fails the run
  sources/     rss | hackernews | github, fetch injected for tests
  core/        normalize, dedupe, filter, rank, chunk, redact, pipeline
  schedule/    timezone → UTC cron, reverse lookup, drift guard
  enrich/      policy (pure) | prompt | llm client | sanitize | replay
  render/      markdown | html | text
  archive/     read/write, fs injected for tests
  channels/    wecom, email, serverchan, pushplus, wxpusher, telegram, stdout
  site/        archive/**/*.json -> static site (see docs/PAGES.md)
```

Adding a channel is one file, one registry line, and one boundary table in `test/`.
