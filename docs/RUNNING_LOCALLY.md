# Running the monitor locally

Dropwatch Monitor runs as one Node process on this PC. There is no server: **monitoring only happens while
the PC is awake and the process is running.**

## Start

Double-click `scripts\start-monitor.cmd`, or from a terminal:

```
cd C:\Users\aa\Desktop\dropwatch
npm run monitor
```

The dashboard is at http://127.0.0.1:4200. `start-monitor.cmd` restarts the process 30 seconds after it exits
unexpectedly; `npm run monitor` does not.

Run it in its own window (the launcher, or a normal PowerShell/Command Prompt window) rather than a terminal
inside another app, so closing that app doesn't stop monitoring.

## Stop and restart

- Stop: `Ctrl+C` in the monitor window (with the launcher, answer `Y` to "Terminate batch job").
- Restart: start it again as above. Nothing needs resetting.

On restart the scheduler continues from the saved state: each target's last check and the per-site pacing
are stored, so a restart never causes a burst of requests. Checks that fell due while the monitor was not
running are not replayed; the next due target is checked on the next tick.

## When monitoring stops

| Situation | What happens |
| --- | --- |
| PC sleeps or hibernates | No checks while asleep. The process resumes on wake and picks up the next due check. |
| PC shuts down or restarts | Monitoring stops until you start it again. |
| Monitor window closed, or process exits | Monitoring stops (the launcher restarts it on an unexpected exit). |
| Network down | Fetches fail; the source backs off (interval doubles per failure) and recovers on its own. |
| Site blocks, challenges or rate-limits | The source pauses (24 h after a challenge or block). Never treated as a ticket change. |

To keep it running, set Windows to not sleep while plugged in (Settings → System → Power & sleep).

## What persists

Everything lives in `data\monitor\` (git-ignored):

| File | Contents |
| --- | --- |
| `monitor.json` | Watchlist (`targets`), events and tiers, observation and change history, alerts, source health, users |
| `outbox.jsonl` | One line per alert sent (append-only) |

Saves are atomic (written to `monitor.json.tmp`, then renamed), so a crash or power cut cannot leave a
half-written file. History is capped at the newest 5,000 observations, 10,000 changes and 5,000 alerts.

**One writer at a time.** Don't run `node monitor/cli.js ingest`, `fixture` or `fetch` against the same data
while the monitor is running: both processes write `monitor.json` and the last save wins. `compare` is
safe at any time (it uses a throwaway in-memory store). Use the API instead while it runs, e.g. add a target:

```
curl -X POST http://127.0.0.1:4200/api/targets -H "content-type: application/json" -d "{\"source\":\"fatsoma\",\"target\":\"<event page URL>\",\"interval_minutes\":60}"
```

## Settings in use (`.env`)

```
DROPWATCH_LIVE_FATSOMA=on                 # live checks for Fatsoma only
DROPWATCH_SCHEDULER=on
DROPWATCH_INTERVAL_FATSOMA_MINUTES=60     # 60 is the floor for public pages
```

Pacing is per site, not per event: at most one request to Fatsoma per interval in total, so with three
targets each event is checked about every three hours.

## Watching organiser pages (Fatsoma)

A Fatsoma organiser page (`https://www.fatsoma.com/p/<organiser>`) lists that organiser's 12 soonest events with
every ticket tier, so one check covers up to 12 events. Add it like any target:

```
curl -X POST http://127.0.0.1:4200/api/targets -H "content-type: application/json" -d "{\"source\":\"fatsoma\",\"target\":\"https://www.fatsoma.com/p/riffraff\",\"interval_minutes\":60}"
```

- The first check is a baseline: what is already listed is recorded without "new event" alerts.
- An event watched on its own page is not checked separately while the organiser page lists it.
- An event that drops off the list (ended, or pushed out of the 12) is left as it was, never treated as
  cancelled or sold out.
- All watches on one site share its hourly slot in rotation, most overdue first.

## Signal priority (which watch is checked next)

With `DROPWATCH_SIGNAL_PRIORITY=on`, when several watches on a site are due, the one whose events show the
strongest signal is checked first: a tier that just sold out (the next wave often follows), a remaining count
that is falling towards zero, a published release within a few hours, or an event starting within 72 hours.
Events with no ticket change for days are checked last. Signals never send alerts and never add requests: the
site still gets one request per hour, and any watch 3 intervals overdue is checked next regardless.

Each request's reason is in the request log. To see what was found, when, and why that check ran:

```
node monitor/cli.js detection-report --hours 48
```

Each alerted change is listed with the window it appeared in (between the previous check and the one that found
it), the check that found it and its reason, the cache status, and when the alert was sent. `--all` also lists
recorded-only changes. Read-only.

## Bursts and triggers (minutes-level checks after a sign)

With `DROPWATCH_SIGNAL_BURSTS=on`, a check that finds a main ticket tier has just sold out, or a remaining count
heading to zero within 2 hours, arms extra checks of the same page at +2, +5 and +15 minutes: the next wave usually
opens soon after. External triggers do the same from outside, starting with an immediate check:

```
node monitor/cli.js trigger --url <event page url> --reason "email said tickets are on sale"
node monitor/cli.js trigger --email saved-message.eml
```

(`trigger` goes through the running monitor's API, `POST /api/triggers`, so only one process writes the data.)

Rules: a trigger never alerts by itself (only a page check that finds a real change does); one active trigger per
type per watch; all extra checks, bursts and release windows together, share `DROPWATCH_RELEASE_MAX_EXTRA_PER_HOUR`
(default 4) per site; no extra checks while the site is backing off or paused; the minimum gap still applies.

```
node monitor/cli.js trigger-report --hours 48
```

lists every trigger, the checks it caused, the first change they found and how many minutes after the trigger, and
for email triggers whether the page had already shown a change before the email arrived.

## Release windows (faster alerts around known releases)

With `DROPWATCH_RELEASE_WINDOW=on`, a watched event whose page publishes a release time (a tier's on-sale
time, or the event's on-sale or presale time) gets a few extra checks around it: by default 2 minutes before,
then 1, 5 and 15 minutes after. Everything else stays at one request per site per hour.

Limits, all in `.env` and clamped to hard ceilings:

| Setting | Default | Meaning |
| --- | --- | --- |
| `DROPWATCH_RELEASE_OFFSETS_MINUTES` | `-2,1,5,15` | When to check, relative to the release |
| `DROPWATCH_RELEASE_MAX_CHECKS` | 4 | Extra checks per release per event |
| `DROPWATCH_RELEASE_MAX_EXTRA_PER_HOUR` | 4 | Extra requests per site in any rolling hour (site total: 1 + this) |
| `DROPWATCH_RELEASE_SLOT_TOLERANCE_MINUTES` | 3 | A slot not run within this many minutes is logged as missed, not fired late |
| `DROPWATCH_MIN_REQUEST_GAP_SECONDS` | 60 | Minimum gap between any two requests to a site |

No extra checks run while a site is backing off or paused, and a release time is only used once Dropwatch has
seen it on the page. Every request (normal and extra) is recorded in `request_log` in `monitor.json`.

To see whether the extra checks make alerts faster:

```
node monitor/cli.js release-report --hours 48
```

It lists requests per site and kind, and for each release window the checks made, missed or skipped, and how
many minutes after the release the first change was detected. It only reads, so it's safe while the monitor
runs.

## Checking it is working

- `GET http://127.0.0.1:4200/api/sources`: per-site state, last success, failures, pauses.
- `GET http://127.0.0.1:4200/api/targets`: each target's last check and result.
- `data\monitor\outbox.jsonl`: alerts sent.
