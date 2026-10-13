import { defineConnector } from './base.js';
import { jsonLd, isEventNode, canonicalUrl } from '../html.js';
import { schemaEvent } from './schema-org.js';

// Resident Advisor — priority 5. Scaffolding only.
// Observed: the inspected page returned a CAPTCHA challenge, so the live event-page structure is UNVERIFIED.
// CAPTCHA and interruption pages are recognised and rejected; nothing attempts to solve them. The parser
// below reads generic Schema.org JSON-LD so the normalisation pipeline can be exercised with SYNTHETIC
// fixtures; it must not be treated as a working RA parser.

export const residentAdvisor = defineConnector({
  id: 'resident-advisor',
  name: 'Resident Advisor',
  parserVersion: 'ra-scaffold@0',
  domains: ['ra.co'],
  defaultTimezone: 'Europe/London',
  defaultCurrency: 'GBP',
  access: { method: 'fixture_only', liveRetrieval: 'not_permitted', requiresConfig: [], notes: 'Live page returned a CAPTCHA. No live retrieval. Needs an approved data source.' },
  verification: 'synthetic fixtures only; live structure unverified',
  expectedContent: body => jsonLd(body).nodes.some(isEventNode),

  parse(body, { observation }) {
    const { nodes, errors } = jsonLd(body);
    const ev = nodes.filter(isEventNode);
    if (ev.length !== 1) return { events: [], anomalies: [], errors: [...errors, ev.length ? 'more than one Event node' : 'no Event node'] };
    const r = schemaEvent(ev[0], { timezone: 'Europe/London' });
    const url = r.fields.canonical_url ?? canonicalUrl(body) ?? observation?.target;
    r.fields.canonical_url = url;
    r.fields.source_event_id = String(url ?? '').match(/ra\.co\/events\/(\d+)/)?.[1] ?? null;
    r.fields.timezone = 'Europe/London';
    r.fields.uncertain_fields = r.uncertain;
    return {
      events: [{ fields: r.fields, provenance: r.provenance, tiers: r.tiers, quarantined: [], warnings: [...r.warnings, 'RA parser is scaffolding; live page structure unverified'], unavailable: [], confidence: 0.5 }],
      anomalies: [], errors,
    };
  },
});
