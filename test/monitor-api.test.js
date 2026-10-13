import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../monitor/config.js';
import { createMonitorApp, manifest } from '../monitor/app.js';

async function start(devRoutes = true) {
  const dataDir = mkdtempSync(join(tmpdir(), 'dropwatch-monitor-'));
  const app = createMonitorApp({ config: loadConfig({}, { dataDir, devRoutes }) });
  const base = await app.start(0);
  const api = async (method, path, body) => {
    const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
  };
  return { app, api, dataDir, close: async () => { await app.stop(); rmSync(dataDir, { recursive: true, force: true }); } };
}

test('api: dashboard, health, fixture replay, feed, event detail, preferences and notifications', async () => {
  const { app, api, dataDir, close } = await start();
  try {
    const page = await api('GET', '/');
    assert.equal(page.status, 200);
    assert.match(page.data, /<title>Dropwatch Monitor<\/title>/);

    let h = (await api('GET', '/api/health')).data;
    assert.equal(h.ok, true);
    assert.equal(h.scheduler, 'off');
    assert.equal(h.sources.find(s => s.source === 'skiddle').state, 'stale', 'never observed');

    await api('PUT', '/api/users/demo', { follows: { artists: ['KETTAMA'] }, cities: ['Manchester'] });
    for (const id of ['skiddle-v1', 'dice-v1']) assert.equal((await api('POST', '/api/dev/ingest', { fixture: id })).status, 200);
    const feed = (await api('GET', '/api/feed?user=demo')).data;
    assert.equal(feed.total, 1, 'Skiddle and DICE listings of the same night are one opportunity');
    assert.deepEqual(feed.items[0].events.map(e => e.source).sort(), ['dice', 'skiddle']);
    assert.equal(feed.items[0].match.match, true);
    assert.equal(feed.items[0].events[0].data_origin, 'fixture');

    const steps = manifest().demo.steps;
    let last;
    for (let i = 0; i < steps.length; i++) last = (await api('POST', '/api/dev/next-step')).data;
    assert.equal(last.step, steps.length);
    assert.equal((await api('POST', '/api/dev/next-step')).data.done, true);

    const detail = (await api('GET', '/api/events/skiddle%3A40118811')).data;
    assert.equal(detail.event.start_at, '2026-11-07T22:00:00.000Z');
    assert.ok(detail.changes.some(c => c.kind === 'status_changed'));
    assert.ok(detail.tiers.length >= 3);
    assert.deepEqual(detail.also_listed_on, [], 'rescheduled Skiddle date no longer matches the DICE listing');
    assert.equal((await api('GET', '/api/events/nope')).status, 404);

    const notes = (await api('GET', '/api/notifications?user=demo')).data;
    assert.ok(notes.length >= 2);
    assert.ok(notes.every(n => n.url && n.observed_at));
    const outbox = readFileSync(join(dataDir, 'outbox.jsonl'), 'utf8').trim().split('\n');
    assert.equal(outbox.length, notes.length);

    h = (await api('GET', '/api/health')).data;
    assert.equal(h.sources.find(s => s.source === 'skiddle').state, 'parse_error', 'last step was the malformed page');
    assert.equal(h.sources.find(s => s.source === 'resident-advisor').state, 'challenge_detected');
    const sources = (await api('GET', '/api/sources')).data;
    assert.ok(sources.every(s => s.last_origin === null || s.last_origin === 'fixture'));

    const bad = await api('PUT', '/api/users/demo', { max_price: 'cheap' });
    assert.equal(bad.status, 422);
    assert.equal((await api('POST', '/api/targets', { source: 'skiddle', target: 'https://www.skiddle.com/x/1/' })).status, 409, 'live retrieval off');
  } finally {
    await close();
  }
  assert.ok(app);
});

test('api: development routes are off unless enabled', async () => {
  const { api, close } = await start(false);
  try {
    assert.equal((await api('POST', '/api/dev/next-step')).status, 404);
    assert.equal((await api('GET', '/api/dev/fixtures')).status, 404);
  } finally {
    await close();
  }
});
