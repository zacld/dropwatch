// Shared setup for the monitor tests. Everything is in memory with a controllable clock; no network.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../monitor/config.js';
import { createMonitorStore } from '../monitor/store.js';
import { createEngine } from '../monitor/engine.js';
import { defaultPreferences } from '../monitor/preferences.js';
import { connectorById } from '../monitor/connectors/index.js';
import { runConnector } from '../monitor/connectors/base.js';

export const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
export const fixture = f => readFileSync(join(FIXTURES, f), 'utf8');

export const T0 = Date.parse('2026-10-13T09:00:00Z');
export const HOUR = 3_600_000;
export const iso = ms => new Date(ms).toISOString();

export function parse(source, file, { status = 200, observed_at = iso(T0), body } = {}) {
  return runConnector(connectorById(source), { body: body ?? fixture(file), status, observed_at, origin: 'fixture' });
}

export function setup({ users, configOverrides = {}, env = {} } = {}) {
  const clock = { t: T0 };
  const config = loadConfig(env, configOverrides);
  const store = createMonitorStore(null);
  const sent = [];
  const notifier = { id: 'test', async send(n) { sent.push(n); return { delivered: true }; } };
  const engine = createEngine({ store, config, notifier, now: () => clock.t });
  for (const u of users ?? [{ ...defaultPreferences('u1') }]) store.data.users[u.id] = u;
  // observe(file) ingests a fixture as if retrieved now (or at `at`).
  const observe = (source, file, { at = clock.t, status = 200, body } = {}) =>
    engine.ingest({ source, status, observed_at: iso(at), origin: 'fixture', body: body ?? fixture(file) });
  return { clock, config, store, db: store.data, engine, sent, observe };
}
