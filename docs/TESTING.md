# Tests

```
npm test               # everything: monitor + the existing checkout tests (about 12 s)
npm run test:monitor   # monitor only (under 1 s)
```

The tests make no requests to ticketing websites and need no API keys or paid services. Live-retrieval code is
tested against a stubbed `fetch`. Fixtures are in `fixtures/`, and `fixtures/manifest.json` records what each one is.

## Results: 13 Oct 2026, Node 24.21, Windows 10

61 tests, 61 passed, 0 failed, 0 skipped.

| File | Tests | Covers |
| --- | --- | --- |
| `test/monitor-parsers.test.js` | 23 | Each parser on its fixtures. Missing and malformed fields; timezone handling including the DST gap and overlap; tier association and quarantine; currency and price parsing; challenge, CAPTCHA and interruption detection; the response classifier; model validation |
| `test/monitor-engine.test.js` | 22 | End to end (fixture → normalise → persist observation → change → one deduplicated notification); markup-only changes; deduplication across platforms; duplicate-alert window; invalid responses never alert; conflicts; uncertain required fields; missing fields ≠ sold out; stale and out-of-order observations; reschedule and postpone; on-sale and presale publication; Fatsoma tiers; confidence threshold; source health and recovery; kill switch; preferences; scheduler back-off and pause; live-retrieval refusals and key redaction; store migration |
| `test/monitor-api.test.js` | 2 | HTTP API and dashboard served; full demo replay through the API; outbox file; development routes off by default |
| `test/rules.test.js`, `test/system.test.js` | 14 | The existing checkout prototype. Unchanged and still passing |

## Spec requirement → test

| Requirement | Test |
| --- | --- |
| Each parser on saved fixtures | `skiddle:*`, `fatsoma:*`, `dice:*`, `ticketmaster:*`, `resident advisor:*` |
| Missing and malformed fields | `skiddle: no offers…`, `skiddle: malformed…`, `dice: reads state; optional fields…`, `model: …` |
| Timezone handling | `time: offsets, epochs, DST gap and overlap`, `skiddle: local time without an offset…` |
| Ticket-tier association | `fatsoma: tiers are accepted only with ownership evidence…`, `fatsoma: a tier with no event id…` |
| Currency and price parsing | `money: …`, `model: prices need a currency…` |
| Event de-duplication | `the same night on two platforms…`, `markup and styling changes alone…`, end-to-end repeat observation |
| Change detection | end to end, `rescheduling and postponement…`, `newly published on-sale and presale…`, `fatsoma tier releases…` |
| Duplicate-alert prevention | `the same change is not alerted twice…`, end to end |
| Challenge-page detection | `skiddle: the WAF challenge…`, `ticketmaster: interruption page…`, `resident advisor: CAPTCHA…` |
| Stale data | `stale observations are stored as history but never alert`, `the real Ticketmaster payload… is stale` |
| Source failure recovery | `source health: challenge pauses the source; a later valid observation recovers it` |
| Invalid data never triggers a release alert | `challenge, CAPTCHA, error and malformed responses never create changes or alerts`, `conflicting observations…`, `a field missing…` |

## Manual check

`npm run monitor:demo` was run and the dashboard checked in a browser at desktop and 375 px widths: the feed,
the event detail dialog (fields with states, tiers, quarantine, history), the source health table, the sample-data
labels and the demo replay steps. There were no console errors and no horizontal scrolling on mobile.
