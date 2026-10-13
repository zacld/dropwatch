# Dropwatch roadmap

**Principle:** prove one category, perfect the core, then expand. The engine is designed to support other
categories from the start, but only ticket-specific functionality is built until Phase 1 is done.

**Direction:** website monitoring → change detection → alerts. Public pages are the primary data source;
this is not an API-integration project.

| Phase | Scope | Goal |
| --- | --- | --- |
| **1. Ticket monitoring (now)** | Scope ticketing websites, investigate them with REA, establish what is observable, build the monitoring and alert engine | Detect a real ticket availability or price change |
| 2. Expand ticket coverage | More sellers, venues, artists, presales and event types; reliability, duplicate handling, alert speed | A genuinely useful ticket-monitoring product |
| 3. Football and sports | Match tickets, fixture announcements, hospitality, availability changes on the same engine | Reuse the core rather than rebuild it |
| 4. Shopping and reservations | Product restocks, price drops, restaurant bookings and other time-sensitive opportunities | A multi-category monitoring platform |
| 5. Consumer app and Premium | Accounts, watchlists, push notifications, subscriptions, purchase assistance where supported | Monetise the monitoring infrastructure |

## Phase 1: done so far

- Five platforms researched (Skiddle, Fatsoma, DICE, Ticketmaster UK, Resident Advisor; [SOURCES.md](SOURCES.md)).
  REA attached to a real Skiddle page load; Fatsoma and DICE observed through ordinary page loads; Ticketmaster
  UK and Resident Advisor event pages served bot challenges / CAPTCHA to plain visits (13 Oct 2026).
- Engine proven on saved real pages: two snapshots → changes → one de-duplicated alert for Skiddle and Fatsoma
  ([CHANGE_DETECTION.md](CHANGE_DETECTION.md), `test/monitor-real.test.js`).
- Fatsoma live: three events watched locally since 13 Oct 2026 ([RUNNING_LOCALLY.md](RUNNING_LOCALLY.md)).

## Phase 1: next steps (agreed 13 Oct 2026)

| # | Step | Done when |
| --- | --- | --- |
| 1 | Keep Fatsoma running locally and prove real change detection | A genuine release, price change or sell-out on a live page produces exactly one correct alert, with no false alerts or duplicates |
| 2 | Release-time-aware checking (alert-speed priority) | Checks cluster around published release times within the existing per-site request limits; no blanket increase in polling |
| 2b | Faster Fatsoma detection | See [PLAN_FATSOMA_DETECTION.md](PLAN_FATSOMA_DETECTION.md): organiser pages, signal-driven timing, email-push test, then targeted bursts |
| 3 | Adapter self-checks | Saved real-page fixtures catch parsing regressions, and a clear alert fires when a live adapter stops extracting expected data |
| 4 | Alternative change signals | Live page updates, platform notification emails and sitemaps assessed; any adopted signal is a module feeding the existing engine |
| 5 | Skiddle as second live source, then DICE validated on a real page | Each adapter passes its fixtures **and** live checks before it is called working |
| 6 | Domain-pack split at the shared data-model boundary | Ticket fields live in the tickets pack; no shopping or restaurant fields designed yet |

**Phase 1 exit criterion:** step 1, on a live page, not a derived fixture.

**Rules throughout:** monitoring and purchasing stay separate systems; fixes are test-driven; a failed fetch,
missing field or parse error is never interpreted as a ticket selling out.

**Hosting:** local PC only, no server spending. Monitoring stops when the PC sleeps, shuts down or the process
exits. Revisit cloud hosting when Dropwatch must run independently of this PC or support users.

## Engine shape for later categories

Every planned category has the same structure: one **item** with **options** whose state changes.

| Category | Item | Options | Changes that matter |
| --- | --- | --- | --- |
| Tickets | event | ticket tiers | released, sold out, price, presale → general, cancelled/postponed |
| Football | fixture | ticket categories, hospitality packages | as tickets |
| Shopping | product | variants (size, colour) | restock, sold out, price drop |
| Reservations | venue + date | time slots | slot opens, slot gone |

Already category-neutral: retrieval (`retrieve.js`), response classification (`classify.js`), source health and
back-off (`health.js`), scheduling (`scheduler.js`).

Currently ticket-specific inside the core: the canonical model (`model.js`), engine (`engine.js`), change rules
(`changes.js`), alert wording (`notify.js`), user matching (`preferences.js`), store layout (`store.js`) and the
connector contract (`connectors/base.js`) all assume "event with tiers".

Planned seam: a **domain pack** supplies the fields, tracked changes, cross-source match key, alert wording and
preference matching; the core keeps items, options, snapshots, comparison, ordering, de-duplication and delivery.
Tickets is the first and, during Phase 1, only pack.
