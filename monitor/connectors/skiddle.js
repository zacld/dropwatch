import { defineConnector } from './base.js';
import { jsonLd, isEventNode, nextData, canonicalUrl } from '../html.js';
import { schemaEvent } from './schema-org.js';

// Skiddle — priority 1.
// Observed (one public event page, 5 Oct 2026): Next.js, server-rendered HTML, Schema.org Event JSON-LD in
// the initial HTML with dates, venue, prices, availability and on-sale information; ticket-box details load
// in a separate request that has not been mapped; an AWS WAF integration script is present on normal pages.
//
// This parser reads only the JSON-LD in the initial HTML. It does not fetch or assume the ticket-box data,
// and it never reports ticket quantities.

const ID_FROM_URL = /skiddle\.com\/.*?\/(\d{5,})\/?(?:[?#].*)?$/i;

export const skiddle = defineConnector({
  id: 'skiddle',
  name: 'Skiddle',
  parserVersion: 'skiddle-jsonld@1',
  domains: ['skiddle.com'],
  defaultTimezone: 'Europe/London',
  defaultCurrency: 'GBP',
  access: {
    method: 'public_html',
    liveRetrieval: 'not_assessed',
    requiresConfig: [],
    notes: 'Initial-HTML JSON-LD only. Skiddle also offers an official API and affiliate feeds, which should be assessed before any live polling.',
  },
  verification: 'synthetic fixtures modelled on one observed page',
  expectedContent: body => jsonLd(body).nodes.some(isEventNode),

  parse(body, { observation }) {
    const { nodes, errors } = jsonLd(body);
    const anomalies = [];
    const events = nodes.filter(isEventNode);
    const canonical = canonicalUrl(body) ?? observation?.target ?? null;
    const pageId = canonical?.match(ID_FROM_URL)?.[1] ?? null;
    const nd = nextData(body);
    if (nd.error) anomalies.push(`__NEXT_DATA__ unreadable: ${nd.error}`);

    // The page's own event: the JSON-LD node whose URL/id matches the canonical URL. Other Event nodes
    // (related events) are ignored, never merged.
    let own = events.filter(n => pageId && String(n.url ?? n['@id'] ?? '').match(ID_FROM_URL)?.[1] === pageId);
    if (!own.length && events.length === 1) own = events;
    if (events.length > own.length) anomalies.push(`${events.length - own.length} other Event node(s) on the page ignored`);
    if (own.length > 1) {
      anomalies.push('more than one Event node claims this page; observation rejected');
      return { events: [], anomalies, errors: [...errors, 'ambiguous event identity'] };
    }
    if (!own.length) return { events: [], anomalies, errors: [...errors, 'no Event node for this page'] };

    const node = own[0];
    const r = schemaEvent(node, { timezone: 'Europe/London', currency: 'GBP' });
    const id = String(node.url ?? '').match(ID_FROM_URL)?.[1] ?? pageId;
    r.fields.source_event_id = id;
    r.provenance.source_event_id = 'canonical url';
    r.fields.canonical_url ??= canonical;
    r.fields.timezone = 'Europe/London';
    r.fields.uncertain_fields = r.uncertain;
    r.fields.categories = [].concat(node['@type'] ?? []).includes('MusicEvent') ? ['music'] : [];
    const warnings = [...r.warnings, 'ticket-box data (separate request) not retrieved; per-ticket availability may be incomplete'];

    const confidence = 0.85 - (r.uncertain.length ? 0.2 : 0) - (r.warnings.some(w => w.includes('no UTC offset')) ? 0.05 : 0);
    return {
      events: [{ fields: r.fields, provenance: r.provenance, tiers: r.tiers, quarantined: [], warnings, unavailable: [], confidence }],
      anomalies,
      errors,
    };
  },
});
