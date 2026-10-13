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

## Checking it is working

- `GET http://127.0.0.1:4200/api/sources`: per-site state, last success, failures, pauses.
- `GET http://127.0.0.1:4200/api/targets`: each target's last check and result.
- `data\monitor\outbox.jsonl`: alerts sent.
