import { testSellerAdapter } from './test-seller.js';
import { ticketmasterAdapter } from './ticketmaster.js';
import { skiddleAdapter } from './skiddle.js';

// Seller adapters available to this Companion, keyed by seller id. New sellers are added here.
export function loadAdapters({ testSellerUrl = 'http://127.0.0.1:4100', skiddleUrl, skiddleOptions = {}, pollMs } = {}) {
  return {
    'test-seller': testSellerAdapter({ baseUrl: testSellerUrl, pollMs }),
    ticketmaster: ticketmasterAdapter,
    ...(skiddleUrl ? { skiddle: skiddleAdapter({ baseUrl: skiddleUrl, pollMs, ...skiddleOptions }) } : {}),
  };
}
