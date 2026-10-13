# Dropwatch

Dropwatch has two parts:

1. **Dropwatch Monitor** (`monitor/`, new): finds events, records what ticketing platforms publish about them,
   detects meaningful changes (new events, on-sale and presale times, published status, prices, tiers,
   reschedules and cancellations), and sends de-duplicated alerts to users whose interests match.
   It only reads. It never buys anything.
2. **Checkout prototype** (`server/`, `companion/`, `test-seller/`, existing): customer-authorised automated
   checkout. It is documented [below](#checkout-prototype-existing) and is unchanged by the monitor work.

Node 20 or later. One dependency (`playwright-core`), used only by the checkout prototype.

## Dropwatch Monitor

### Quick start

```
npm install
npm test               # 61 tests, no network, no API keys
npm run monitor:demo   # sample data, http://127.0.0.1:4200
```

The demo starts with an empty store in `data/monitor-demo/`, follows a few artists for a demo user, and loads
the initial fixtures through the full pipeline. **Replay next observation** steps through later observations:
a markup-only change, a WAF challenge, real status, price and tier changes, a repeat, conflicting data, a CAPTCHA,
a reschedule and a malformed page. Each step reports what it caused. Everything is labelled *Sample*.

To run against your own store (empty until you ingest something):

```
cp .env.example .env   # optional; every setting has a default
npm run monitor        # http://127.0.0.1:4200, data in data/monitor/
node monitor/cli.js fixture --id skiddle-v1
node monitor/cli.js ingest --source skiddle --file saved-page.html --url <page url>
node monitor/cli.js status
```

`ingest` takes a page or API response you saved yourself (origin *manual*). `fetch` makes **one** live request,
and only if `DROPWATCH_LIVE_<SOURCE>=on` (off for every source by default; Resident Advisor is refused in code).
Initialisation is automatic: the store file is created on first run and migrated when its schema version changes.

### How it fits together

```
retrieve.js ─┐ fixture / manual file / one permitted HTTP request
             ▼
classify.js     challenge · captcha · blocked · rate_limited · error → stop (health updated)
             ▼
connectors/*    parse JSON-LD / app state → canonical fields, tiers, quarantine, provenance, confidence
             ▼
engine.js       order + freshness checks → persist (store.js) → changes.js → notify.js (preferences.js)
             ▼
health.js       per-source state, freshness, pauses and back-off      app.js  HTTP API + web/monitor.html
```

| Path | What it is |
| --- | --- |
| `monitor/connectors/` | One connector per platform behind a common interface (`base.js`): Skiddle, Fatsoma, DICE, Ticketmaster, Resident Advisor |
| `monitor/model.js` | Canonical event and tier schema, validation, field states |
| `monitor/classify.js` | Response classification before any parsing |
| `monitor/changes.js`, `engine.js` | Deterministic change detection and the ingest pipeline |
| `monitor/health.js`, `scheduler.js` | Source health; conservative opt-in polling |
| `monitor/preferences.js`, `notify.js` | User interests, matching, de-duplicated local notifications (`outbox.jsonl`) |
| `monitor/app.js`, `web/monitor.html` | API and dashboard: feed, search, details and history, preferences, alerts, source health |
| `fixtures/` | Saved payloads; `manifest.json` labels each as synthetic or real |
| `docs/` | [Source research](docs/SOURCES.md) · [Capability matrix](docs/CAPABILITIES.md) · [Schema](docs/SCHEMA.md) · [Change detection](docs/CHANGE_DETECTION.md) · [Tests](docs/TESTING.md) |

### API

`GET /api/health` (status endpoint) · `GET /api/sources` · `GET /api/feed?user=&q=&city=&source=&from=&to=&max_price=&only_matching=1` ·
`GET /api/events/:id` · `GET /api/changes` · `GET /api/observations` · `GET /api/notifications?user=` ·
`GET|PUT /api/users/:id` · `GET|POST /api/targets` · dev only (`DROPWATCH_DEV_ROUTES=on`): `/api/dev/fixtures`, `/api/dev/ingest`, `/api/dev/next-step`.

### Configuration and safety

All settings come from environment variables; see [`.env.example`](.env.example). Each source has a kill switch
(`DROPWATCH_SOURCE_<ID>=off`) and a separate live-retrieval switch that is off by default. Polling has hard floors
(60 min for pages, 30 min for APIs), doubles after each failure, and **pauses** for 24 h after a challenge or block
(at least 6 h, or Retry-After if longer, after a rate limit). Logs are JSON lines, with API keys, tokens, cookies
and credential query parameters redacted. Requests time out (15 s by default) and responses are capped at 5 MB.
The monitor stores no passwords, session cookies or ticketing-site tokens, and does not automate checkout.

### Source status

| Source | Parser | Data it has been checked against | Live |
| --- | --- | --- | --- |
| Skiddle | JSON-LD | Synthetic fixtures modelled on one observed page | Not tested |
| Fatsoma | Shoebox state with tier ownership checks | Synthetic fixtures | Not tested |
| DICE | Next.js state + JSON-LD | Synthetic fixtures | Not tested |
| Ticketmaster | Discovery API | **One real API payload** (1 Oct 2026) + synthetic variant | Not tested in the monitor |
| Resident Advisor | Scaffold only | Synthetic only; live page returned a CAPTCHA | Refused |

None of these connectors runs live yet. Details are in the [capability matrix](docs/CAPABILITIES.md).

### Known limitations

- **Every HTML parser is built from descriptions of single page views.** The Skiddle, Fatsoma and DICE fixtures
  are hand-written to match those descriptions. Field names (Fatsoma's JSON:API shape, DICE's `dates.*`), units
  (pence) and price meaning (face value vs. including booking fee) are assumptions until real saved pages are tested.
- No live retrieval has been run through the monitor. Access methods and reuse rights have not been assessed for
  Skiddle, Fatsoma or DICE. Ticketmaster's API display terms have not been reviewed.
- Skiddle's separate ticket-box data is not read, so per-ticket status comes only from JSON-LD.
- Ticketmaster gives event-level sale status only. No source gives ticket quantities, and none are shown.
- Matching the same night across platforms uses normalised title, local date and venue. Differently worded
  titles will not merge.
- The dashboard has one user (`demo`) and no sign-in. Notifications go only to the local outbox; there is no push or email yet.
- The store is a single JSON file, which suits one process and modest volumes.
- Prices in different currencies are not converted. A ceiling only applies to events priced in the user's currency.

### Next three priorities

1. **Validate parsers on real saved pages.** Save a few public Skiddle, Fatsoma and DICE event pages by hand
   (`monitor/cli.js ingest`), turn them into fixtures, correct the parsers, and record the results in the matrix.
2. **Assess access routes before any live polling.** Skiddle's official API and affiliate feeds, Fatsoma and DICE
   terms, and Ticketmaster's Discovery API terms. Enable `DROPWATCH_LIVE_TICKETMASTER` first, since it is an official API.
3. **Real delivery and accounts.** Add push and email behind the notifier interface, plus multi-user sign-in. Then
   add travel price monitoring as a new connector and record type (see [schema](docs/SCHEMA.md#travel-later)).

## Checkout prototype (existing)

> The monitor brief rules out checkout automation and storing ticketing-site sessions. This earlier prototype does
> both: the Skiddle adapter drives a signed-in Chrome profile kept in `data/skiddle-profile/`. It has been left
> unchanged and is separate from the monitor. Decide whether to keep it before any production use.

Customer-authorised, single-attempt automated ticket checkout. The customer sets the event, quantity, tier rule, per-ticket maximum and total spend cap, and authorises one purchase attempt. At release, the Dropwatch Companion on the customer's own device carries out that attempt through their signed-in seller account and saved card, then confirms the result.

No dependencies. Node 20 or later.

```
npm run demo       # test seller + Dropwatch server + Companion, all local
npm test           # rules, controls and a 40-release end-to-end run
npm run harness    # 200 simulated releases (or: node harness/run.js 500 42)
```

With the demo running, open http://127.0.0.1:4000 to arm a watch, then use http://127.0.0.1:4100/admin to bring that event's release forward and watch the attempt.

### Parts

| Path | What it is |
| --- | --- |
| `web/` | Customer app: watches, authorisation, statuses, release log, notifications |
| `server/` | Dropwatch server: watches, authorisation records, attempt lock, result checks, signed instructions, notifications |
| `shared/rules.js` | The hard rules, used by both server and Companion |
| `shared/authorisation.js` | Authorisation wording, hashing, Ed25519 signing |
| `companion/` | The Companion that runs on the customer's device, plus seller adapters |
| `companion/adapters/` | One adapter per seller: `test-seller.js` (enabled), `ticketmaster.js` (registered, disabled) |
| `test-seller/` | Local Ticketmaster-style seller used to prove the workflow |
| `harness/` | Reliability harness that runs many releases and checks every rule against the seller's records |

### The controls

- **Authorisation is exact.** The server generates the wording from the terms. The customer must confirm that exact text (matched by hash), and any change to the form clears the confirmation.
- **Instructions are signed.** The server signs each instruction with Ed25519. The Companion pins the server key, checks the signature, regenerates the wording from the terms and refuses anything that doesn't match. A tampered instruction is refused before the lock is taken.
- **One attempt.** The server's attempt lock lets exactly one claim succeed per watch, even with two devices racing. The Companion submits checkout once and never retries, including when the outcome is unclear.
- **Hard limits, checked three times.** Tier choice is made from what is actually on sale. The basket is checked against quantity, tier rule, per-ticket max and total cap before checkout. The confirmed order is checked again by the Companion and independently by the server, which raises an alert on any breach.
- **Seller limits.** Quantity is capped at the seller's per-customer limit, less tickets Dropwatch already secured for the event. Only one active watch is allowed per event.
- **The customer handles checks.** Identity and payment checks pause the attempt ("Needs you") and notify the customer. The Companion never completes them itself.
- **Nothing is left hanging.** A watch whose Companion was offline at release, or that stops responding mid-attempt, ends as Failed with a notification. It is not retried.
- **Credentials stay on the device.** Seller sign-ins live only in `data/companion/sessions.json`; the server never receives them.
- **Release changes are followed.** If a seller moves a release, armed watches update and the Companion joins the waiting room when it actually opens.

### Results (500 releases, seed 42)

| Outcome | Runs |
| --- | --- |
| Secured | 209 |
| Nothing eligible on sale (sold out or over the customer's limits) | 222 |
| Payment declined or not approved | 22 |
| Customer did not complete a seller check | 9 |

Every outcome that depended on the workflow itself ended in a confirmed purchase: 0 workflow errors, 0 late waiting-room joins, 0 hard-rule violations, and 231 checkout submissions for 231 attempts that reached checkout. The misses come from the scenarios, which are deliberately hard: random queue places, crowds buying the cheap tiers first, and tight limits.

### Skiddle (first live-site target)

`companion/adapters/skiddle.js` drives a real Chrome browser (Playwright) through Skiddle's buying flow in the customer's own signed-in session: account check, waiting room and queue, the ticket form, checkout (refund protection answered from the customer's preference, paid extras unticked, terms ticked) and one press of Pay. Payment routes: PayPal agreement and Skiddle credit can complete without the customer; card hands off to the customer's phone. It buys only within the authorised ticket family (General Admission), so entry-time tickets, bundles and VIP are never picked by "any eligible tier". If the chosen tier sells out before it reaches the basket, "any eligible tier" re-reads the list and takes the next one; checkout is still submitted only once.

It is developed against `sellers/skiddle-sim`, a local copy of Skiddle's flow built from the pages observed on 5 Oct 2026. It has not been run against skiddle.com.

```
node harness/skiddle-run.js 30        # 30 attempts, headless
node harness/skiddle-run.js 3 --watch # on screen, slowed down
```

First results (30 attempts): 28 secured, 2 card payments not completed by the customer, 0 rule violations, median 7.9 s from start to confirmation.

### Ticketmaster

Ticketmaster is the intended first real seller. Its adapter is registered but disabled, and the server does not offer Ticketmaster for automated checkout. Ticketmaster's Purchase Policy (clause 4.10) prohibits unauthorised automated purchasing, so the adapter is written once Ticketmaster authorises Dropwatch, through written permission or Partner API access. Everything else in this repository is built so that adding it changes only `companion/adapters/ticketmaster.js` and the seller entry in `server/sellers.js`.

### Not built yet

- Customer accounts and sign-in (the server is single-customer).
- A packaged desktop Companion with device pairing (it currently uses a shared token).
- Real push and email delivery (notifications go to the app and `data/server/outbox.jsonl`).
- Fee billing.
- Ticketmaster Discovery API import for real UK events and on-sale times.
