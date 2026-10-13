// Sellers Dropwatch knows about. A seller is only offered to customers when its Companion adapter is
// enabled; the same flag lives in companion/adapters so neither side acts alone.

export const TICKETMASTER_STATUS =
  'Ticketmaster is the intended first real seller. Automated checkout is not enabled until Ticketmaster '
  + 'authorises it (written permission or Partner API access), because its Purchase Policy prohibits '
  + 'unauthorised automated purchasing.';

export function defaultSellers(testSellerUrl, skiddleUrl) {
  return [
    { id: 'test-seller', name: 'Test Seller (local)', enabled: true, catalogueUrl: `${testSellerUrl}/api/catalogue` },
    // The local Skiddle copy; the live Skiddle plug-in is the same adapter pointed at skiddle.com.
    ...(skiddleUrl ? [{ id: 'skiddle', name: 'Skiddle (local copy)', enabled: true, catalogueUrl: `${skiddleUrl}/api/catalogue` }] : []),
    { id: 'ticketmaster', name: 'Ticketmaster', enabled: false, reason: TICKETMASTER_STATUS },
  ];
}

// Pull each enabled seller's public event catalogue into one list.
export async function loadEvents(sellers) {
  const events = [];
  for (const s of sellers.filter(s => s.enabled && s.catalogueUrl)) {
    try {
      const res = await fetch(s.catalogueUrl);
      if (!res.ok) continue;
      for (const ev of await res.json()) events.push({ ...ev, sellerId: s.id, sellerName: s.name });
    } catch {
      // Seller unreachable: its events are simply not offered until it is back.
    }
  }
  return events.sort((a, b) => a.saleStart - b.saleStart);
}
