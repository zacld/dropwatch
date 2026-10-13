# Connector capability matrix

A cell says "yes" only when this repository holds evidence for it. Test results are from `npm test` run
on 13 Oct 2026 (see [TESTING.md](TESTING.md)).

| Capability | Skiddle | Fatsoma | DICE | Ticketmaster | Resident Advisor |
| --- | --- | --- | --- | --- | --- |
| Parser implemented | Yes: JSON-LD | Yes: shoebox state + JSON-LD cross-check | Yes: `__NEXT_DATA__` + JSON-LD | Yes: Discovery API JSON | Scaffold only (generic JSON-LD) |
| Challenge / interruption recognised | Yes (AWS WAF fixture) | Shared classifier (no source-specific fixture) | Shared classifier (no source-specific fixture) | Yes (interruption fixture) | Yes (CAPTCHA fixture) |
| Fixture tests passing | Yes, 8 parser tests | Yes, 3 parser tests | Yes, 3 parser tests | Yes, 4 parser tests | Yes, 1 parser test |
| Fixtures are | Synthetic, modelled on one observed page | Synthetic, modelled on one observed page | Synthetic, modelled on one observed page | **One real API payload** (1 Oct 2026) + one synthetic variant | Synthetic; structure unknown |
| Live retrieval tested | **No** | **No** | **No** | **No** in this build (the API was called by `scripts/discovery-sweep.js` on 1 Oct 2026; the monitor's own live path is only tested against a stubbed `fetch`) | **No**: not permitted |
| Repeated observations validated | Fixtures only | Fixtures only | Fixtures only | Fixtures only | No |
| Change detection verified | Yes, on fixtures (status, price, tiers, reschedule, conflict, missing fields) | Yes, on fixtures (tier status/release, quarantine) | Yes, on fixtures (on-sale and presale published) | Yes, on fixtures (postponed, price published) | No (below alert confidence) |
| Access method assessed | Not assessed (Skiddle API / affiliate feed should be assessed first) | Not assessed | Not assessed | Official API with key. Display terms **not** reviewed | Live page returned a CAPTCHA. Needs an approved source |
| Reuse rights assessed | No | No | No | Partly: official API, terms not reviewed | No |
| Live retrieval in config | Off by default | Off by default | Off by default | Off by default. Needs `TICKETMASTER_API_KEY` | Refused in code |

## What each status means

- **Parser implemented**: code exists that turns a payload into the shared schema.
- **Fixture tests passing**: automated tests run that parser against files in `fixtures/`.
- **Live retrieval tested**: the monitor has fetched a real page or API response and parsed it. No source has this yet.
- **Repeated observations validated**: two or more real observations of the same event, compared. No source has this yet.
- **Access method assessed**: someone has checked the platform's terms or API agreement for this use and recorded it.
