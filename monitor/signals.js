// Signals: evidence in stored state that a page is likely to change soon. They only decide WHICH due watch gets a
// site's next check; they never alert and never add requests (Phase 2 of docs/PLAN_FATSOMA_DETECTION.md).
//
// Per event, from its main (non add-on) tiers' history:
//   sold_out_followup  a tier went sold out recently; the next wave often opens right after (strongest when no
//                      other main tier is on sale)
//   falling_count      remaining tickets fell within the last 24 h and project to run out soon, or are low and falling
//   release_soon       a published release time (tier or event on-sale/presale) falls within the next few hours
//   event_soon         the event starts within the next few days
//   quiet              nothing changed for days: checked after everything else that is due
// A flat count is not a signal, however low it is: "FINAL 20" unchanged for days is quiet, not urgent.

const HOUR = 3_600_000;
const flag = (v, d) => (v === undefined || v === '' ? d : /^(1|on|true|yes)$/i.test(v));
const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function signalConfig(env = process.env) {
  return {
    enabled: flag(env.DROPWATCH_SIGNAL_PRIORITY, false),
    soldOutFollowupHours: clamp(num(env.DROPWATCH_SIGNAL_SOLD_OUT_FOLLOWUP_HOURS, 6), 1, 48),
    lowStock: clamp(num(env.DROPWATCH_SIGNAL_LOW_STOCK, 25), 1, 1000),
    projectSellOutHours: clamp(num(env.DROPWATCH_SIGNAL_PROJECT_HOURS, 6), 1, 72),
    releaseSoonHours: clamp(num(env.DROPWATCH_SIGNAL_RELEASE_SOON_HOURS, 3), 1, 24),
    eventSoonHours: clamp(num(env.DROPWATCH_SIGNAL_EVENT_SOON_HOURS, 72), 1, 336),
    quietDays: clamp(num(env.DROPWATCH_SIGNAL_QUIET_DAYS, 3), 1, 30),
    // A due watch is never passed over once it is this many intervals overdue, whatever the signals say.
    maxOverdueIntervals: clamp(num(env.DROPWATCH_SIGNAL_MAX_OVERDUE_INTERVALS, 3), 1, 12),
  };
}

const STRENGTH = { sold_out_followup: 3, sold_out_followup_other_on_sale: 2, falling_count: 2, release_soon: 1.5, event_soon: 1, quiet: -1 };
const mins = ms => Math.round(ms / 60_000);

// ev: stored event; tiers: its stored tiers (with `history`); now: ms.
export function eventSignals(ev, tiers, now, cfg) {
  const out = [];
  const main = tiers.filter(t => !t.addon && t.listed !== false);
  const onSale = main.filter(t => t.status === 'on_sale');

  for (const t of main) {
    const h = t.history ?? [];
    for (let i = h.length - 1; i > 0; i--) {
      if (h[i].status === 'sold_out' && h[i - 1].status !== 'sold_out') {
        const ago = now - Date.parse(h[i].at);
        if (ago >= 0 && ago <= cfg.soldOutFollowupHours * HOUR) {
          const type = onSale.length ? 'sold_out_followup_other_on_sale' : 'sold_out_followup';
          out.push({ type, strength: STRENGTH[type], reason: `"${t.name}" sold out ${mins(ago)} min ago${onSale.length ? '' : '; nothing else on sale'}` });
        }
        break;
      }
    }
  }

  for (const t of onSale) {
    const pts = (t.history ?? []).filter(p => Number.isInteger(p.qty) && now - Date.parse(p.at) <= 24 * HOUR);
    if (pts.length < 2) continue;
    const first = pts[0];
    const last = pts[pts.length - 1];
    const hours = (Date.parse(last.at) - Date.parse(first.at)) / HOUR;
    if (last.qty >= first.qty || hours <= 0) continue;
    const perHour = (first.qty - last.qty) / hours;
    const toZero = last.qty / perHour;
    if (toZero <= cfg.projectSellOutHours || last.qty <= cfg.lowStock) {
      out.push({ type: 'falling_count', strength: STRENGTH.falling_count + (toZero <= 2 ? 0.5 : 0), hours_to_zero: toZero, tier: t.name, reason: `"${t.name}" ${first.qty} → ${last.qty} left in ${hours.toFixed(1)} h (~${toZero.toFixed(1)} h to sell out)` });
    }
  }

  const upcoming = [
    ...main.filter(t => t.status === 'not_yet_released' && t.release_at).map(t => [t.release_at, `"${t.name}"`]),
    ...(ev.published_on_sale_at ? [[ev.published_on_sale_at, 'general sale']] : []),
    ...(ev.published_presale_at ? [[ev.published_presale_at, 'presale']] : []),
  ].map(([at, what]) => [Date.parse(at) - now, what]).filter(([d]) => d > 0 && d <= cfg.releaseSoonHours * HOUR).sort((a, b) => a[0] - b[0]);
  if (upcoming.length) out.push({ type: 'release_soon', strength: STRENGTH.release_soon, reason: `${upcoming[0][1]} release in ${mins(upcoming[0][0])} min` });

  const toStart = ev.start_at ? Date.parse(ev.start_at) - now : null;
  if (toStart !== null && toStart > 0 && toStart <= cfg.eventSoonHours * HOUR) out.push({ type: 'event_soon', strength: STRENGTH.event_soon, reason: `starts in ${Math.round(toStart / HOUR)} h` });

  if (!out.length) {
    const lastChange = Math.max(Date.parse(ev.first_seen_at ?? 0) || 0, ...main.flatMap(t => (t.history ?? []).map(p => Date.parse(p.at))));
    if (now - lastChange >= cfg.quietDays * 24 * HOUR) out.push({ type: 'quiet', strength: STRENGTH.quiet, reason: `no ticket change for ${Math.floor((now - lastChange) / (24 * HOUR))} days` });
  }
  return out;
}

// The strongest signal across the events a watch shows (an organiser page shows many).
export function watchPriority(events, tiersOf, now, cfg) {
  const all = events.flatMap(ev => eventSignals(ev, tiersOf(ev.id), now, cfg).map(s => ({ ...s, event_id: ev.id, title: ev.title })));
  if (!all.length) return { strength: 0, signals: [] };
  all.sort((a, b) => b.strength - a.strength);
  return { strength: all[0].strength, signals: all.slice(0, 3) };
}
