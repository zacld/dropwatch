# Change detection

Code: `monitor/engine.js` (pipeline), `monitor/changes.js` (comparison), `monitor/notify.js` (alerts).

## Pipeline for one observation

1. **Kill switch.** If `DROPWATCH_SOURCE_<ID>=off`, the observation is logged as `disabled` and stops here.
2. **Classify** the response (`monitor/classify.js`). Anything other than `ok` (challenge, CAPTCHA, blocked,
   rate limited, not found, server error, empty, unexpected content, network error, timeout) updates source
   health and stops here. **It cannot create an event, a change or an alert.**
3. **Parse and normalise** (connector, then `model.js`). Invalid values are dropped and reported. An event that
   lacks `source_event_id`, `title` or `start_at` is rejected.
4. **Order and freshness.**
   - If the observation is older than the stored one for that event, it is ignored as out of order.
   - If it is older than `DROPWATCH_MAX_OBSERVATION_AGE_HOURS` when it arrives, it is stored as history, but
     every change from it is marked ineligible ("already stale when received").
5. **Duplicate check.** If the content hash (extracted fields and tiers only) equals the stored one, the outcome
   is `unchanged`. Only `last_seen_at` is updated. Navigation or styling changes end here.
6. **Field comparison.** Only fields **confirmed** in this observation can change.
   - confirmed and different from before: change recorded
   - confirmed and previously empty: recorded as *published* for on-sale, presale, price and status;
     first-time values of other fields are stored silently
   - `missing` / `uncertain` / `unavailable`: the last valid value is kept, the field state shows why,
     and **no change** is recorded
7. **Tier comparison** by `source_tier_id`: added, status changed, price changed, release time changed, re-listed.
   A tier that disappears is recorded as `tier_not_listed`, which never alerts and never sets the tier to sold out.
   Quarantined tiers are not compared.
8. **Eligibility** of each change (`changes.js#eligibility`). A change can alert only if every one of these holds:
   - its kind is one users can subscribe to
   - the observation was not already stale when received
   - connector confidence ≥ `DROPWATCH_MIN_ALERT_CONFIDENCE` (default 0.7). A conflicting observation lowers
     confidence below this
   - the field is confirmed
9. **Notifications** (`notify.js#dispatchNotifications`). For each user whose preferences match the event and
   who wants that kind of change, all fresh eligible changes from one observation are sent as **one** notification.

## Change kinds

| Kind | From | Alert group |
| --- | --- | --- |
| `new_event` | first valid observation | `new_event` |
| `date_changed`, `venue_changed` | `start_at`, `venue_name`, `city` | `date_venue` |
| `price_published`, `price_changed` | `minimum_price`, `maximum_price` (merged into one change when both move) | `price` |
| `status_published`, `status_changed` | `published_availability_status` | `status` |
| `on_sale_published`, `on_sale_changed` | `published_on_sale_at` | `on_sale` |
| `presale_published`, `presale_changed` | `published_presale_at` | `presale` |
| `cancellation` | `cancellation_status` (cancelled, postponed, rescheduled, moved online, reinstated) | `cancellation` |
| `tier_added`, `tier_status_changed`, `tier_price_changed`, `tier_release_changed` | tiers | `tiers` |
| `title_changed`, `end_time_changed`, `currency_changed`, `tier_not_listed`, `tier_relisted` | | recorded, not alerted |

## De-duplication

- **Observations**: an unchanged content hash records nothing new, so repeating an observation is harmless.
- **Alerts**: each change in a notification has a key `user | subject | kind | field | new value`. A key
  that was sent within `DROPWATCH_ALERT_DEDUPE_HOURS` (default 24) is withheld and counted in `suppressed`.
  If a page flips between two states, the user is told once per window, not on every flip.
- **Across platforms**: for `new_event`, the subject is the event's `match_key` (normalised title, local date
  and venue), so the same night listed on Skiddle and DICE is announced once. The feed groups those listings as one opportunity.

## Conflicts

When a single observation contradicts itself, the field is `uncertain`. Examples: Skiddle offers say in stock
while the AggregateOffer says sold out; DICE state and JSON-LD give different start times. The previous
valid value is kept, the observation's confidence drops below the alert threshold, and the source shows
`degraded`. A new event whose required field is uncertain is not created.

## Wording

Every alert describes what the source **published** and when it was observed, for example "Skiddle listed
the event as on sale (was not yet on sale) when last checked" or "DICE published a general sale time: Fri 16
Oct 2026, 10:00 BST. Not on sale before then." Every alert includes the canonical source URL and the
observation time. No alert says tickets are available now.
