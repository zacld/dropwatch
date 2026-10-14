// Triggers and what they led to: the checks each one caused, the first change those checks found, and, for an
// external trigger (e.g. an email), whether the page had already shown a change for that event shortly before it
// (i.e. the page beat the email).
export function triggerReport(db) {
  const checksOf = id => (db.request_log ?? []).filter(r => r.kind === 'burst' && r.trigger_id === id);
  const changesByObs = new Map();
  for (const c of db.changes ?? []) { if (!changesByObs.has(c.observation_id)) changesByObs.set(c.observation_id, []); changesByObs.get(c.observation_id).push(c); }
  return (db.trigger_log ?? []).map(e => {
    const checks = checksOf(e.id).sort((a, b) => a.at.localeCompare(b.at));
    const found = checks.filter(r => r.requested).flatMap(r => (changesByObs.get(r.observation_id) ?? []).filter(c => !e.event_id || c.event_id === e.event_id));
    const first = found.sort((a, b) => a.observed_at.localeCompare(b.observed_at))[0] ?? null;
    let before = null;
    if (e.type === 'external' && e.event_id) {
      const prior = (db.changes ?? []).filter(c => c.event_id === e.event_id && c.kind !== 'new_event' && c.observed_at < e.at && Date.parse(e.at) - Date.parse(c.observed_at) <= 6 * 3_600_000);
      const last = prior.sort((a, b) => b.observed_at.localeCompare(a.observed_at))[0];
      if (last) before = { kind: last.kind, observed_at: last.observed_at, minutes_before_trigger: Math.round((Date.parse(e.at) - Date.parse(last.observed_at)) / 60_000) };
    }
    return {
      ...e,
      title: e.event_id ? db.events?.[e.event_id]?.title ?? null : null,
      checks: checks.map(r => ({ at: r.at, offset_minutes: r.offset_minutes, requested: r.requested, outcome: r.outcome, changes: r.changes ?? [] })),
      first_change: first ? { kind: first.kind, kinds: found.filter(c => c.observed_at === first.observed_at).map(c => c.kind), tier: first.tier ?? null, observed_at: first.observed_at, minutes_after_trigger: Math.round((Date.parse(first.observed_at) - Date.parse(e.at)) / 6000) / 10 } : null,
      page_change_before: before,
    };
  });
}

// Detection timeline: for each recorded change, the window in which it became visible (after the previous valid
// observation, by this one), the check that found it and why that check ran, and the alert it produced.
export function detectionReport(db, { sinceMs = 0, includeRecordOnly = false } = {}) {
  const reqByObs = new Map((db.request_log ?? []).filter(r => r.observation_id).map(r => [r.observation_id, r]));
  const alertByChange = new Map();
  for (const n of db.notifications ?? []) for (const id of n.change_ids ?? []) if (!alertByChange.has(id)) alertByChange.set(id, n);
  return (db.changes ?? [])
    .filter(c => Date.parse(c.observed_at) >= sinceMs && (includeRecordOnly || c.notify_eligible))
    .map(c => {
      const req = reqByObs.get(c.observation_id) ?? null;
      const alert = alertByChange.get(c.id) ?? null;
      const windowMin = c.appeared_after ? Math.round((Date.parse(c.observed_at) - Date.parse(c.appeared_after)) / 60_000) : null;
      return {
        change_id: c.id,
        event_id: c.event_id,
        title: db.events?.[c.event_id]?.title ?? null,
        kind: c.kind,
        tier: c.tier ?? null,
        previous: c.previous,
        current: c.current,
        appeared_after: c.appeared_after ?? null,
        observed_at: c.observed_at,
        window_minutes: windowMin,
        found_by: req ? { kind: req.kind, reason: req.reason ?? null, cache_status: req.cache_status ?? null, target_id: req.target_id } : { kind: 'not a scheduled check' },
        alerted_at: alert?.created_at ?? null,
        alert_delay_seconds: alert ? Math.round((Date.parse(alert.created_at) - Date.parse(c.observed_at)) / 1000) : null,
        notify_eligible: c.notify_eligible,
        ineligible_reason: c.ineligible_reason ?? null,
      };
    });
}
