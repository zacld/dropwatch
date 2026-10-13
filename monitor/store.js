import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

// JSON file store for the monitor, following server/store.js: single process, synchronous saves.
// `file: null` keeps everything in memory (tests). The schema is versioned; migrate() upgrades old files.

export const SCHEMA_VERSION = 2;
const LIMITS = { observations: 5000, changes: 10000, notifications: 5000, request_log: 5000 };

export function emptyData() {
  return {
    schema_version: SCHEMA_VERSION,
    events: {},          // id → canonical event
    tiers: {},           // `${event_id}|${source_tier_id}` → tier
    quarantined: {},     // event_id → [{ tier, reason, observed_at }]
    observations: [],    // every attempt, newest last (raw bodies are not kept)
    changes: [],         // change records, newest last
    notifications: [],   // delivered notifications, newest last
    suppressed: 0,       // alerts withheld by de-duplication
    sources: {},         // source id → health record
    users: {},           // user id → preferences
    targets: [],         // live monitoring targets (scheduler)
    request_log: [],     // every scheduled live request (normal and release-window), newest last
    seq: 1,
  };
}

const MIGRATIONS = {
  // 0 → 1: files written before versioning had no quarantine map or suppressed counter.
  0: d => ({ ...emptyData(), ...d, quarantined: d.quarantined ?? {}, suppressed: d.suppressed ?? 0, schema_version: 1 }),
  // 1 → 2: request log for the scheduler (release-window checks).
  1: d => ({ ...d, request_log: d.request_log ?? [], schema_version: 2 }),
};

export function migrate(data) {
  let d = data;
  let v = d.schema_version ?? 0;
  if (v > SCHEMA_VERSION) throw new Error(`monitor data schema ${v} is newer than this code (${SCHEMA_VERSION})`);
  while (v < SCHEMA_VERSION) { d = MIGRATIONS[v](d); v = d.schema_version; }
  return d;
}

export function createMonitorStore(file = null) {
  if (file) mkdirSync(dirname(file), { recursive: true });
  const data = file && existsSync(file) ? migrate(JSON.parse(readFileSync(file, 'utf8'))) : emptyData();
  const nextId = prefix => `${prefix}_${String(data.seq++).padStart(6, '0')}`;
  return {
    data,
    nextId,
    save() {
      for (const [k, max] of Object.entries(LIMITS)) if (data[k].length > max) data[k].splice(0, data[k].length - max);
      if (!file) return;
      const tmp = file + '.tmp';
      writeFileSync(tmp, JSON.stringify(data, null, 1));
      renameSync(tmp, file);
    },
  };
}
