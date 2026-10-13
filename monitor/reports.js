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
