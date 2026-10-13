import { connectorById, CONNECTORS } from './connectors/index.js';
import { runConnector } from './connectors/base.js';
import { initialHealth, recordResult, recordDisabled, currentHealth } from './health.js';
import { diffEventFields, diffTiers, eligibility } from './changes.js';
import { dispatchNotifications } from './notify.js';
import { matchKey } from './values.js';
import { EVENT_FIELDS } from './model.js';
import { silentLogger } from './log.js';

// Ingestion pipeline: classify → parse → normalise (connector) → freshness/order checks → persist →
// change detection → notifications. Retrieval happens before this (retrieve.js / fixtures / manual files).

const HOUR = 3_600_000;

export function createEngine({ store, config, notifier, now = () => Date.now(), log = silentLogger, connectors = CONNECTORS }) {
  const db = store.data;
  const sourceNames = Object.fromEntries(connectors.map(c => [c.id, c.name]));
  for (const c of connectors) db.sources[c.id] ??= initialHealth(c);

  // observation: { source, target, observed_at, origin, status, headers, body, error }
  async function ingest(observation) {
    const connector = connectorById(observation.source);
    if (!connector) throw new Error(`unknown source ${observation.source}`);
    const t = now();
    const health = db.sources[connector.id];
    const obsRec = {
      id: store.nextId('obs'),
      source: connector.id,
      target: observation.target ?? null,
      origin: observation.origin ?? 'manual',
      fixture: observation.fixture ?? null,
      observed_at: observation.observed_at ?? new Date(t).toISOString(),
      received_at: new Date(t).toISOString(),
      parser_version: connector.parserVersion,
    };

    if (!config.sources[connector.id]?.enabled) {
      recordDisabled(health, t);
      Object.assign(obsRec, { classification: 'disabled', status: 'rejected', outcome: 'source disabled by kill switch', events: [] });
      db.observations.push(obsRec);
      store.save();
      log.warn('ingest.disabled', { source: connector.id });
      return { observation: obsRec, events: [], changes: [], notifications: [] };
    }

    const result = runConnector(connector, { ...observation, observed_at: obsRec.observed_at });
    Object.assign(obsRec, {
      classification: result.classification,
      evidence: result.evidence,
      status: result.status,
      payload_hash: result.payload_hash,
      payload_bytes: result.payload_bytes,
      errors: result.errors,
      anomalies: result.anomalies,
      events: [],
    });
    recordResult(health, result, { now: t, intervalMinutes: config.sources[connector.id].intervalMinutes });

    if (!result.ok) {
      obsRec.outcome = result.classification === 'ok' ? 'parse failed; nothing stored' : `${result.classification}; nothing parsed`;
      db.observations.push(obsRec);
      store.save();
      log.warn('ingest.rejected', { source: connector.id, classification: result.classification, errors: result.errors.slice(0, 3) });
      return { observation: obsRec, events: [], changes: [], notifications: [] };
    }

    const observedMs = Date.parse(obsRec.observed_at);
    const staleOnArrival = t - observedMs > config.maxObservationAgeHours * HOUR;
    // Ordering uses when the content was generated (CDN Age taken off) when the retriever knows it.
    const asOf = observation.content_as_of && observation.content_as_of <= obsRec.observed_at ? observation.content_as_of : obsRec.observed_at;
    obsRec.content_as_of = asOf;
    const lastAsOf = p => p.last_content_as_of ?? p.last_successful_observation_at;
    const newChanges = [];
    const touched = [];

    for (const ev of result.events) {
      const sid = ev.fields.source_event_id;
      const id = `${connector.id}:${sid}`;
      const entry = { event_id: id, outcome: null };
      obsRec.events.push(entry);
      if (ev.rejected) { entry.outcome = `rejected: missing ${ev.missing_required.join(', ')}`; continue; }
      const prev = db.events[id] ?? null;

      if (!prev && ev.uncertain_required.length) { entry.outcome = `rejected: ${ev.uncertain_required.join(', ')} uncertain and no earlier valid value`; continue; }
      if (prev && obsRec.observed_at < prev.last_successful_observation_at) { entry.outcome = 'out of order: older than the stored observation; ignored'; continue; }
      if (prev && asOf < lastAsOf(prev)) { entry.outcome = `stale copy: content generated ${asOf}, older than the stored ${lastAsOf(prev)}; ignored`; continue; }
      if (prev && prev.content_hash === ev.content_hash) {
        prev.last_seen_at = obsRec.observed_at;
        prev.last_successful_observation_at = obsRec.observed_at;
        prev.last_content_as_of = asOf;
        prev.observation_count = (prev.observation_count ?? 1) + 1;
        prev.data_origin = obsRec.origin;
        pushObs(prev, obsRec.id);
        entry.outcome = 'unchanged';
        touched.push(id);
        continue;
      }

      const { fields, field_meta, diffs } = diffEventFields(prev, ev, obsRec.observed_at);
      const record = {
        ...(prev ?? {}),
        id,
        source: connector.id,
        ...fields,
        source_event_id: sid,
        field_meta,
        first_seen_at: prev?.first_seen_at ?? obsRec.observed_at,
        last_seen_at: obsRec.observed_at,
        last_successful_observation_at: obsRec.observed_at,
        last_content_as_of: asOf,
        data_confidence: ev.confidence,
        source_payload_hash: result.payload_hash,
        content_hash: ev.content_hash,
        data_origin: obsRec.origin,
        observation_count: (prev?.observation_count ?? 0) + 1,
        warnings: ev.warnings,
        source_metadata: { parser_version: connector.parserVersion, target: obsRec.target, provenance: ev.provenance },
      };
      record.match_key = `${matchKey(record.title)}|${localDate(record.start_at, record.timezone)}|${matchKey(record.venue_name).split(' ')[0] ?? ''}`;
      pushObs(record, obsRec.id);

      // Tiers
      const prevTiers = Object.values(db.tiers).filter(x => x.event_id === id);
      const tierDiffs = prev ? diffTiers(prevTiers, ev.tiers) : [];
      const nextIds = new Set(ev.tiers.map(x => x.source_tier_id));
      for (const tier of ev.tiers) {
        const key = `${id}|${tier.source_tier_id}`;
        // Short history for signals: a point whenever status, remaining count or price changes.
        const history = [...(db.tiers[key]?.history ?? [])];
        const point = { at: obsRec.observed_at, status: tier.status, qty: tier.quantity?.value ?? null, price: tier.price };
        const lastPt = history[history.length - 1];
        if (!lastPt || lastPt.status !== point.status || lastPt.qty !== point.qty || lastPt.price !== point.price) history.push(point);
        db.tiers[key] = { ...tier, event_id: id, source: connector.id, listed: true, first_seen_at: db.tiers[key]?.first_seen_at ?? obsRec.observed_at, last_seen_at: obsRec.observed_at, history: history.slice(-48) };
      }
      for (const p of prevTiers) if (!nextIds.has(p.source_tier_id)) Object.assign(db.tiers[`${id}|${p.source_tier_id}`], { listed: false, status_note: 'not listed in latest observation (not treated as sold out)' });
      db.quarantined[id] = ev.quarantined_tiers.map(q => ({ ...q, observed_at: obsRec.observed_at }));

      const allDiffs = prev ? [...diffs, ...tierDiffs] : [{ field: '*', kind: 'new_event', previous: null, current: { title: record.title, start_at: record.start_at } }];
      for (const d of allDiffs) {
        const fieldState = d.field in (ev.field_states ?? {}) ? ev.field_states[d.field] : null;
        let el = eligibility(d, { confidence: ev.confidence, minConfidence: config.minAlertConfidence, staleOnArrival, fieldState });
        // The first check of a newly added watch (e.g. an organiser page listing 12 events) records what is
        // already there; only events that appear after it are announced as new.
        if (observation.baseline && d.kind === 'new_event' && el.eligible) el = { eligible: false, reason: 'baseline: first check of a newly added watch' };
        newChanges.push({
          id: store.nextId('chg'),
          event_id: id,
          source: connector.id,
          observation_id: obsRec.id,
          observed_at: obsRec.observed_at,
          detected_at: new Date(t).toISOString(),
          // The change became visible after the previous valid observation and by this one.
          appeared_after: prev?.last_successful_observation_at ?? null,
          ...d,
          confidence: ev.confidence,
          notify_eligible: el.eligible,
          ineligible_reason: el.reason,
          data_origin: obsRec.origin,
        });
      }
      db.events[id] = record;
      entry.outcome = prev ? `${allDiffs.length} change(s)` : 'new event';
      touched.push(id);
    }

    if (staleOnArrival) obsRec.note = `observed ${Math.round((t - observedMs) / HOUR)}h before it was received: stored as history, no alerts`;
    db.changes.push(...newChanges);
    db.observations.push(obsRec);
    const notifications = await dispatchNotifications({
      store, notifier, changes: newChanges, events: db.events, sourceNames, now: t, dedupeHours: config.alertDedupeHours, log,
    });
    store.save();
    log.info('ingest', { source: connector.id, origin: obsRec.origin, events: obsRec.events.map(e => `${e.event_id}: ${e.outcome}`), changes: newChanges.length, notifications: notifications.length });
    return { observation: obsRec, events: touched.map(id => db.events[id]), changes: newChanges, notifications };
  }

  // Read helpers that apply freshness at read time.
  function eventView(e) {
    const t = now();
    const stale = !e.last_successful_observation_at || t - Date.parse(e.last_successful_observation_at) > config.staleAfterHours * HOUR;
    const field_meta = { ...e.field_meta };
    if (stale) for (const k of EVENT_FIELDS) if (field_meta[k]?.state === 'confirmed') field_meta[k] = { ...field_meta[k], state: 'stale' };
    return { ...e, field_meta, freshness: stale ? 'stale' : 'fresh', source_name: sourceNames[e.source] ?? e.source };
  }
  const sourcesView = () => connectors.map(c => currentHealth(db.sources[c.id], c, { now: now(), cfg: config }));

  return { ingest, eventView, sourcesView, sourceNames };
}

function pushObs(rec, obsId) {
  rec.observation_ids = [...(rec.observation_ids ?? []), obsId].slice(-50);
}

function localDate(utc, tz) {
  if (!utc) return '';
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(utc)); }
  catch { return utc.slice(0, 10); }
}
