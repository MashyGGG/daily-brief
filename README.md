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
| `WECOM_WEBHOOK_ME`                                                                                             | no       | WeCom group-robot webhook, full URL; omit it and that recipient is skipped |
| `RECIPIENTS_OVERRIDE_JSON`                                                                                     | no       | private recipients that must not be committed                              |
| `SERVERCHAN_KEY` `PUSHPLUS_TOKEN` `WXPUSHER_APP_TOKEN` `WXPUSHER_UIDS` `TELEGRAM_BOT_TOKEN` `TELEGRAM_CHAT_ID` | no       | only if you enable those channels                                          |
| `RESEND_API_KEY`                                                                                               | no       | only with a verified custom domain                                         |
| `GITHUB_TOKEN`                                                                                                 | auto     | raises the GitHub search rate limit and makes the archive commit           |

A `secretRef` pointing at an unset variable **skips that recipient** and says so in the run
summary. It does not fail the run, and it does not affect anybody else.

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

Delivery lands between 08:00 and 08:30 Beijing time: Actions schedules routinely run 5–30 minutes
late, and the top of the hour is the most congested slot. `lookbackHours` covers the window, so a
skipped run loses no content.

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
            ├─ writeArchive (md + json + rebuilt index.md)      ← BEFORE delivery
            ├─ render once per (sections, format) signature
            ├─ deliver concurrently, each recipient in its own try/catch
            └─ commit archive, write $GITHUB_STEP_SUMMARY
```

**Archiving happens before pushing, deliberately.** WeCom or Gmail can fail; the content should not
disappear with them. When delivery fails the job fails and the alert fires, but the issue is already
in the repo and `--from-archive` can resend it.

**Nothing to say means nothing is sent.** A brief with zero qualifying items is not pushed and not
archived — only recorded in the step summary. A daily empty email trains you to ignore the real one.

**Ranking is pure code, no LLM.** `rankScore = sourceWeight × (0.6 × percentile-within-source +
0.4 × recency)`, plus `minPerSource` so one high-volume source cannot eat a section. Deterministic,
fully unit-tested, no API key and no quota. The archive stores the raw items, so an LLM summary
layer could later be replayed over history without re-fetching.

**The archive is also the state.** Cross-day dedupe reads the last 14 days of archived JSON — there
is no second state file to drift out of sync.

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
| `pnpm brief:schedule`                                | regenerate the workflow cron from the config                      |
| `pnpm check:schedule`                                | fail if the workflow and the config disagree                      |
| `pnpm validate`                                      | validate the config and exit                                      |
| `pnpm test`                                          | vitest (pure functions only — no network, no SMTP, no temp files) |
| `pnpm lint` / `pnpm format:check` / `pnpm typecheck` | the rest of CI                                                    |

## Layout

```
brief.config.yaml            the only file you normally edit
.github/workflows/
  daily-brief.yml            cron block generated by pnpm brief:schedule
  ci.yml                     lint / format / typecheck / test / validate / check:schedule
archive/YYYY/MM/             one .md + one .json per issue, plus index.md
src/
  config/      zod schema + loader; invalid config fails the run
  sources/     rss | hackernews | github, fetch injected for tests
  core/        normalize, dedupe, filter, rank, chunk, redact, pipeline
  schedule/    timezone → UTC cron, reverse lookup, drift guard
  render/      markdown | html | text
  archive/     read/write, fs injected for tests
  channels/    wecom, email, serverchan, pushplus, wxpusher, telegram, stdout
```

Adding a channel is one file, one registry line, and one boundary table in `test/`.
