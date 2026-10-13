# Data schema

Storage: `data/monitor/monitor.json` (`DROPWATCH_MONITOR_DATA`). This is a JSON file store, the same
approach as `server/store.js`. It is versioned with `schema_version`, and `monitor/store.js#migrate`
upgrades older files when they are loaded. Raw page bodies are never stored, only their SHA-256 hash and size.

## Event (`events[id]`)

`id` is `"<source>:<source_event_id>"`. All timestamps are UTC ISO-8601 (`...Z`). The source's IANA timezone is kept in `timezone`.

| Field | Type | Notes |
| --- | --- | --- |
| `source`, `source_event_id`, `canonical_url` | string | The URL must be on one of the source's own hosts |
| `title`, `description` | string | HTML stripped; description capped at 2,000 characters |
| `artists`, `categories` | string[] | |
| `venue_name`, `city`, `country` | string | `country` is ISO 3166-1 alpha-2 where it can be recognised |
| `start_at`, `end_at` | UTC ISO | **`start_at` required.** A local time with no offset is resolved in the source timezone and flagged |
| `timezone` | IANA tz | |
| `currency` | ISO 4217 | A price without a currency is dropped |
| `minimum_price`, `maximum_price` | number | Major units. Only from tiers that belong to this event. min ≤ max |
| `published_availability_status` | `on_sale` `not_yet_on_sale` `limited` `sold_out` `off_sale` `unknown` | What the source **published**. Not a live availability check |
| `published_on_sale_at`, `published_presale_at`, `announced_at` | UTC ISO | |
| `cancellation_status` | `scheduled` `cancelled` `postponed` `rescheduled` `moved_online` `unknown` | |
| `first_seen_at`, `last_seen_at`, `last_successful_observation_at` | UTC ISO | Observation times, not ingest times |
| `data_confidence` | 0–1 | From the connector, reduced by problems, conflicts and quarantines |
| `source_payload_hash` | sha256 | Of the raw payload |
| `content_hash` | sha256 | Of the extracted fields and tiers only, so markup changes do not change it |
| `source_metadata` | object | Parser version, target, per-field provenance |
| `field_meta[field]` | `{ state, confirmed_at, via, note }` | Field-level provenance (below) |
| `data_origin` | `fixture` `manual` `live` | The UI labels anything other than `live` |
| `match_key` | string | Normalised title, local date and venue, used to group listings across platforms |

### Field states

| State | Meaning |
| --- | --- |
| `confirmed` | Parsed in the latest valid observation |
| `missing` | A valid observation did not publish it. Any earlier value is kept and labelled |
| `unknown` | Never observed |
| `unavailable` | This access method cannot provide it (for example ticket quantities) |
| `uncertain` | The source contradicted itself. The last valid value is kept |
| `stale` | Confirmed, but outside the freshness window (`DROPWATCH_STALE_AFTER_HOURS`). Worked out when read |

Missing data is never read as sold out.

## Ticket tier (`tiers["<event_id>|<source_tier_id>"]`)

`source_tier_id`, `name`, `price`, `currency`, `release_at` (UTC), `status`
(`on_sale` `not_yet_released` `sold_out` `off_sale` `unknown`), `quantity: { state: 'unavailable', value: null }`,
`listed` (false once the tier stops appearing; the tier is **not** marked sold out), `first_seen_at`, `last_seen_at`, `provenance`.

Quarantined tiers are stored in `quarantined[event_id]` as `[{ tier, reason, observed_at }]` and are never used.

## Observation (`observations[]`)

Every attempt is recorded, including rejected ones: `id`, `source`, `target`, `origin`, `fixture`, `observed_at`,
`received_at`, `classification`, `evidence`, `status` (`valid` `invalid` `rejected`), `payload_hash`,
`payload_bytes`, `parser_version`, `errors`, `anomalies`, `events[{ event_id, outcome }]`, `note`.

## Change (`changes[]`)

`id`, `event_id`, `source`, `observation_id`, `observed_at`, `detected_at`, `field`, `kind`, `previous`, `current`,
`tier` (for tier changes), `confidence`, `notify_eligible`, `ineligible_reason`, `data_origin`.

## Notification (`notifications[]`, also appended to `outbox.jsonl`)

`id`, `user_id`, `event_id`, `change_ids`, `kinds`, `title`, `lines`, `body`, `url` (canonical source page),
`observed_at`, `source`, `data_origin`, `match_reasons`, `match_notes`, `channel`, `created_at`, `dedupe_keys`, `delivered`.

## Source health (`sources[id]`)

`state` (`healthy` `degraded` `blocked` `rate_limited` `challenge_detected` `parse_error` `stale` `disabled`
`awaiting_configuration`), `last_attempt_at`, `last_success_at`, `last_valid_parse_at`, `last_data_observed_at`,
`last_failure_at`, `consecutive_failures`, `failures_total`, `last_classification`, `last_evidence`, `last_errors`,
`parser_version`, `missing_required_fields`, `missing_optional_fields`, `last_origin`, `last_live_success_at`,
`paused_until`, `backoff_level`.

## User preferences (`users[id]`)

`follows { artists, teams, categories, venues, events }`, `cities`, `date_from`, `date_to`, `max_price`, `currency`,
`notify_types` (`new_event` `on_sale` `presale` `status` `price` `date_venue` `cancellation` `tiers`), `sources`, `channels`.

## Travel later

The engine never looks inside an event's fields. Connectors produce normalised records and `changes.js`
compares tracked fields. A flight or holiday-price source would add its own record type, its own tracked-field
table and its own connector, and reuse the classifier, health, observation log, de-duplication and notifier unchanged.
