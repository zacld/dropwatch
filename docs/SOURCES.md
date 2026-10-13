# Source research notes

What each platform has been seen to publish, kept separate from what we assume and what nobody has checked.
These notes come from single page inspections. They don't describe every page, they may stop being true,
and nobody has independently confirmed them.

**Confidence**: *high* means seen directly and saved as evidence in this repo. *medium* means seen once and
recorded in notes, with no saved copy. *low* means reported only, or inferred.
**Validation**: *validated* means a parser has run against a saved real response. *fixture-modelled* means
the parser runs against synthetic fixtures built to match the description. *unverified* means neither.

| Source | Observed at | Basis | Validation |
| --- | --- | --- | --- |
| Skiddle | 5 Oct 2026 | One live event page (WAH Drumsheds 2026) and a checkout page reached by hand. Notes in `research/skiddle.html` | fixture-modelled |
| Fatsoma | Not recorded (reported in the task brief, received 13 Oct 2026) | One public event page | fixture-modelled |
| DICE | Not recorded (reported in the task brief) | One public event page | fixture-modelled |
| Ticketmaster (API) | 1 Oct 2026 | Discovery API v2 responses saved in `data/discovery/` | **validated** against one real payload |
| Ticketmaster (page) | Not recorded (reported in the task brief) | One event page returned an interruption page | unverified |
| Resident Advisor | Not recorded (reported in the task brief) | One event page returned a CAPTCHA | unverified |

---

## Skiddle

**Observed (medium confidence, 5 Oct 2026)**
- The event page is Next.js and server-rendered. A Schema.org Event in JSON-LD is in the initial HTML.
- The JSON-LD had the event name, dates, venue, and one entry per ticket type with name, price and
  in-stock or sold-out status (WAH Drumsheds: four GA releases, three sold out and one on sale).
- Visible prices show face value plus a booking fee of roughly 14% ("£51.95 +bf", £59.22 all-in).
- Ticket-box information loads in a separate request. That request has **not** been mapped.
- An AWS WAF integration script is present on normal event pages.
- The ticket form uses stable ticket IDs (for example `ticket-2451188`). Styling uses generated class names that change.

**Assumptions in the parser**
- The page's own event is the JSON-LD node whose URL ends with the numeric event ID in the canonical URL.
- `offers[].validFrom` is the published on-sale time. `offers[].availability` is the published status.
- The JSON-LD `price` is face value. We have not confirmed whether it ever includes the booking fee.

**Unverified**
- Whether every Skiddle page publishes `validFrom`, `eventStatus` or `previousStartDate`.
- What the ticket-box request returns, and whether we are allowed to use it. We do not request it.
- Skiddle's API and affiliate feed, which are probably the better route for live data. Not yet assessed.

## Fatsoma

**Observed (low–medium confidence)**
- Ember.js with FastBoot. Event structured data and serialised application state are in the initial HTML.
- The state includes ticket tiers, prices, release times and ticket status.
- Some embedded structured data seemed to contain ticket information for **other** events.

**Assumptions in the parser** (none of these have been checked against a saved page)
- The state is a FastBoot shoebox `<script type="fastboot/shoebox">` holding a JSON:API document
  (`data.type == "events"`, `included[]` tickets).
- Tier prices are in minor units (pence). A JSON-LD price that disagrees with this lowers confidence.
- Tier ownership is shown by the event's `relationships.tickets` and/or a tier's `event-id`.

**Ownership rule** (implemented): a tier is accepted only if the event lists it and nothing contradicts that,
or if the tier names this event explicitly. Anything else is quarantined with a reason. That includes JSON-LD
offers whose URL points at another event page. Quarantined tiers never affect prices, statuses or alerts.

## DICE

**Observed (low–medium confidence)**
- Next.js with server-rendered content. Serialised state contained sale-start, presale and announcement dates,
  price information and event status.
- The search-engine JSON-LD was less detailed than the state.

**Assumptions in the parser**
- The state is in `__NEXT_DATA__`, and the event object has `name` plus `dates`/`venues`. Field names such as
  `dates.sale_start_date` and `dates.presale_start_date` are guesses, so several alternative names are tried.
- State prices are in minor units.

**Unverified**
- Whether these fields are complete, and whether reusing embedded state is permitted. No conclusion has been reached.

## Ticketmaster

**Observed (high confidence, 1 Oct 2026, saved in `data/discovery/`)**
- The Discovery API v2 returns event identity, dates with timezone, `dates.status.code` (`onsale`, ...),
  `sales.public` and `sales.presales` times, venue, attractions and classifications. `priceRanges` is often absent.
- A request to the offers endpoint with the project key was refused: `Invalid ApiKey for given resource`.
- The public event page returned a bot-detection / access-interruption page (reported in the brief; not saved).

**Interpretation**
- `dates.status.code` is the sale status for the whole event. It is **not** seat-level inventory, and we never
  present it as availability.
- "onsale" before the published public on-sale time is treated as `not_yet_on_sale` (presale or announced).

**Unverified**
- The Discovery API terms of use for commercial display and alerts. They need review before production use.

## Resident Advisor

**Observed**: the inspected event page returned a CAPTCHA challenge (reported in the brief).
**Unverified**: everything about the event page's structure.
The connector is scaffolding. It recognises CAPTCHA and interruption pages, and runs a generic Schema.org
parser against a **synthetic** fixture so the pipeline can be tested. It reports confidence 0.5, which is below
the alert threshold. It does not count as a working RA parser.

## Rules that apply to every source

- Challenge, CAPTCHA, block and error pages are classified and rejected before parsing.
  Nothing attempts to solve or avoid them.
- No private or undocumented endpoints, no replayed requests, no stored session cookies, no identity
  rotation, and no checkout automation in the monitor.
- When live retrieval is blocked, the source is **paused**. It is not retried more often.
