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

## Phase 1 status

| # | Step | Status |
| --- | --- | --- |
| 1 | Initial ticketing website inventory | Five platforms researched (Skiddle, Fatsoma, DICE, Ticketmaster UK, Resident Advisor; see [SOURCES.md](SOURCES.md)). Inventory of further UK sellers still to do. |
| 2 | REA investigation of priority sites | Skiddle: REA attached to a real page load. Fatsoma and DICE: ordinary page loads. Ticketmaster UK and Resident Advisor event pages served bot challenges / CAPTCHA to plain visits (13 Oct 2026). |
| 3 | Reusable engine on saved examples | Done for Skiddle and Fatsoma real pages: two snapshots → changes → one de-duplicated alert ([CHANGE_DETECTION.md](CHANGE_DETECTION.md), `test/monitor-real.test.js`). DICE connector not yet checked against a real page. |
| 4 | Connect the first website and test real changes over time | Next. |
| 5 | Further sites once the first integration is reliable | Later. |

**Phase 1 exit criterion:** a real change on a live page (not a derived fixture) is detected in two or more
consecutive observations and produces exactly one correct alert.

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
