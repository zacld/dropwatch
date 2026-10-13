# Plan: faster Fatsoma detection

Status: **Phase 1 built and tested** (13 Oct 2026); Phases 2–4 not started. Order agreed: (1) cover more per check, (2) check at the right
moments, (4) test the email push, then (3) targeted bursts. Raising the baseline is a later decision, made only on
evidence.

## Why

Detection speed for unannounced changes (sell-outs, new waves, price changes) equals the time between checks of the
page that shows them. Today that is one request per hour to Fatsoma, one event per request: with three watched
events, each is seen every ~3 h.

Evidence (13 Oct 2026, public pages, see the Fatsoma reconnaissance notes in the session log):

| Fact | Consequence |
| --- | --- |
| Ticket data is only in the server HTML; an open page makes no further ticket requests, no WebSocket/SSE/long-poll | A change is only seen by reloading a page |
| Page cache `max-age=60, stale-while-revalidate=59`, no `Age`, no `ETag` | Checks faster than ~2 min return the same copy; no cheap "changed?" check |
| Sitemaps last modified 26 Jul 2023 | Not usable for discovery |
| Organiser pages (`/p/<slug>`) embed the 12 soonest active events with every tier: `on-sale-status`, `amount-available`, price and fee, on/off-sale times, pre-sale, add-on | One request can cover 12 events |
| No page-2 link in organiser HTML (23 events existed for the observed organiser) | Only the 12 soonest events per organiser are visible |
| 0 of 67 observed tiers had a future `on-sale-at` | Published release windows will rarely fire on Fatsoma; most waves open when the previous tier sells out |

## Rules that do not change

- A failed fetch, missing field, parse error or event missing from a listing is never a sell-out.
- Alerts only from a verified page observation; predictions and emails only decide *when to look*.
- Existing de-duplication, stale-copy ordering, add-on handling and per-site back-off/pauses stay as they are.
- Every phase lands with tests first (real-page fixtures plus simulated schedules) and is off by default until
  enabled in `.env`.
- Monitoring and purchasing stay separate.

---

## Phase 1: organiser pages (more coverage per check, no extra requests)

**Goal:** one request updates up to 12 events, and new events from a watched organiser are discovered.

| Task | Where |
| --- | --- |
| Save today's organiser page as a real fixture (`fixtures/fatsoma/organiser-riffraff-2026-10-13.html`) plus derived variants: a tier sells out, a new tier appears, a new event is added, an event drops off the list | `fixtures/`, `manifest.json` |
| Listing mode: when the shoebox holds an `events` collection, parse every event with its own tiers (same ownership rules: a tier belongs to the event its `relationships.event` names). Event-page mode is unchanged | `monitor/connectors/fatsoma.js` |
| Event identity is the Fatsoma UUID in both modes, so an event seen on its own page and on the organiser page is one record. Canonical URL from `vanity-name` + `seo-name` | same |
| An event absent from a listing is untouched (not cancelled, not sold out); record `last_listed_at` only | `monitor/engine.js` |
| Organiser targets: `POST /api/targets` accepts `/p/<slug>` URLs; record which events each listing covers | `monitor/scheduler.js`, `monitor/app.js` |
| Coverage rule: a watched event not on its organiser's first page keeps an event-page target, which is retired automatically once the event appears in the listing | `monitor/scheduler.js` |
| Record `X-Cache-Status` per response | `monitor/retrieve.js` |

**Done when:** the real organiser fixture parses into 12 events / 62 tiers with zero quarantined; derived variants
produce exactly the expected changes and one alert per event; an event dropping off the list produces no change;
the same event via event page and listing merges into one record; all existing tests pass.

**Expected effect:** typical delay ~30 min, worst ~1 h for every event on a watched organiser's first page, at the
same request rate.

## Phase 2: check at the right moments (same budget, better timing)

**Goal:** within the existing one-request-per-hour baseline, the next check goes to the page most likely to change.

| Task | Where |
| --- | --- |
| Tier history: per tier, keep recent `(observed_at, status, amount_available, price)` points (store schema 3, migrated) | `monitor/store.js`, `monitor/engine.js` |
| Signals computed from stored state, each with a reason string: **sold-out follow-up** (a tier just went `sold_out` and the event has no other main tier on sale); **falling count** (remaining ≤ threshold, or the decline rate projects a sell-out within the next check interval); **event soon** (starts within 72 h); **published release time** (existing release windows); **quiet** (no change in counts for N days) | new `monitor/signals.js` |
| Priority ordering: when a baseline slot is free, the target with the strongest signal goes first instead of round-robin. No new requests | `monitor/scheduler.js` |
| Fatsoma release-window offsets become `-2, +2, +5, +15` (past the ~2-min cache) via per-source offsets | `monitor/config.js` |
| Detection timeline: each change records the previous observation time, so the change is known to have appeared between the two checks; request log records the signal that chose each check | `monitor/engine.js`, `monitor/scheduler.js` |
| `cli.js detection-report`: per change, the window it appeared in, which check found it and why that check ran, time to alert | `monitor/cli.js` |

**Done when:** simulated timelines show signals choosing the right target (a falling-count event is checked before
a quiet one); the hourly budget is never exceeded; signals never alert by themselves.

**Expected effect:** changes that follow a visible signal are found at the next baseline slot instead of a random
one. Without bursts, worst case is still ~1 h.

## Phase 4 (done third): Fatsoma emails as a push trigger, test first

**Goal:** find out whether Fatsoma's own notifications announce drops sooner than our checks would.

| Step | Who |
| --- | --- |
| Create a dedicated mailbox and a Fatsoma account; sign up to ticket reminders / wait lists on 2–3 watched events | **You** (accounts and passwords are yours to create and enter) |
| Log which emails arrive, when, and what they say, against our page observations for the same events, for ~2 weeks | Dropwatch (manual comparison first) |
| Only if emails arrive earlier than our checks: an inbox reader that turns a relevant email into an **immediate verification check** of that event (counts against the burst budget in Phase 3), never an alert on its own | `monitor/sources/email.js`; needs one dependency (IMAP client), to be approved before install |

**Done when:** we know which email types Fatsoma sends, their delay relative to the page, and the decision to
build or drop the inbox reader is made on that data.

## Phase 3 (done fourth): targeted bursts after a trigger

**Goal:** minutes-level detection when a signal says a wave is imminent.

| Task | Where |
| --- | --- |
| Extend the release-window allowance to signal-triggered windows: after a sold-out follow-up, a falling-count trigger or an email trigger, checks at +2, +5 and +15 min | `monitor/scheduler.js` |
| Same safeguards as release windows: per-site extra budget per rolling hour (default 4, ceiling 8), minimum gap, no overlap, nothing while backing off or paused, missed slots logged | `monitor/scheduler.js`, `monitor/config.js` |
| Separate switch `DROPWATCH_SIGNAL_BURSTS=off` and its own per-trigger limit | `monitor/config.js`, `.env.example` |

**Done when:** simulated sell-out → next-wave timelines catch the new tier within ~2–5 min of it appearing; budget
and back-off tests (each safeguard has a test that fails without it) pass; then enabled on the live watch.

**Expected effect:** ~2–5 min after a signal; unannounced drops with no signal stay at the baseline (~30 min
typical, ~1 h worst).

## Later, only on evidence: a higher baseline for chosen organisers

If the detection report shows drops arriving without any preceding signal, raise the baseline for specific organiser
pages only (e.g. every 15 min, worst case ~17 min). Never faster than ~2 min (cache floor). This is a separate
decision.

## Decisions (13 Oct 2026)

| Decision | Outcome |
| --- | --- |
| Pilot organiser | Riff Raff Events (Manchester), `https://www.fatsoma.com/p/riffraff` |
| Manchester Halloween (`w12de4k1`) | Keeps its own event-page watch until it appears in the organiser page's 12-event window (the coverage rule then pauses it) |
| Burst budget | Up to **4 additional checks per hour per site in total**, shared between release windows and signal bursts (not 4 + 4). Back-off, pause and minimum-spacing safeguards unchanged |
| Alert delivery | In-app notifications for now; no external channel yet |

## Phase 1 as built

- Listing mode in `connectors/fatsoma.js`: organiser pages parse into one event per listed event; another event's
  tiers in the shared `included` list are skipped, not quarantined; empty JSON-LD placeholders are ignored.
- Targets carry a kind (`event` / `organiser`); anything else is rejected for Fatsoma.
- The first successful check of a new watch is a **baseline**: events already listed are recorded without
  "new event" alerts; events that appear later are announced.
- Coverage rule: an event-page watch is skipped while an organiser watch's latest check listed its event, and
  resumes if it drops out.
- Release windows apply to every event an organiser watch lists.
- `X-Cache-Status` is recorded in the request log.
- **Scheduler fix found by these tests:** with one request per hour per site, the scheduler always gave the slot to
  the first due target, so later targets on the same site were never checked. The most overdue target now goes
  first, so watches rotate fairly.
- Tests: `test/monitor-organiser.test.js` (real organiser page plus derived v2/v3 fixtures); each new rule has a
  test that fails without it.

## Proof of the whole chain (Phase 1 exit criterion, unchanged)

A real change on a live page (not a fixture) is detected, its appearance window is recorded, and exactly one correct
alert is delivered, with no false alerts or duplicates. The detection report is the evidence.
