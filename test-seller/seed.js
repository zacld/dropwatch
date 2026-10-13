// Demo data for the local test seller. Test values only.

export const TEST_ACCOUNT = { email: 'fan@dropwatch.test', password: 'local-test-seller-only' };

const MIN = 60_000;

export const DEFAULT_EVENTS = (t = Date.now()) => [
  {
    id: 'josh-baker-2027-06-13', name: 'Josh Baker', venue: 'Ibiza · Sun 13 Jun 2027', startsAt: '2027-06-13T23:00:00Z',
    saleStart: t + 5 * MIN, limit: 4,
    tiers: [
      { name: 'Early bird', price: 45, stock: 300 },
      { name: 'Tier 1', price: 60, stock: 400 },
      { name: 'Tier 2', price: 75, stock: 500 },
      { name: 'Final', price: 95, stock: 600 },
    ],
  },
  {
    id: 'kettama-2027-06-23', name: 'Kettama', venue: 'Ibiza · Wed 23 Jun 2027', startsAt: '2027-06-23T23:00:00Z',
    saleStart: t + 30 * MIN, limit: 4,
    tiers: [
      { name: 'Early bird', price: 40, stock: 250 },
      { name: 'Tier 1', price: 55, stock: 400 },
      { name: 'Tier 2', price: 70, stock: 500 },
      { name: 'Final', price: 90, stock: 600 },
    ],
  },
  {
    id: 'prospa-2027-07-02', name: 'Prospa', venue: 'Ibiza · Fri 2 Jul 2027', startsAt: '2027-07-02T23:00:00Z',
    saleStart: t + 24 * 60 * MIN, limit: 6,
    tiers: [
      { name: 'Early bird', price: 35, stock: 300 },
      { name: 'Tier 1', price: 50, stock: 400 },
      { name: 'Tier 2', price: 65, stock: 500 },
      { name: 'Final', price: 85, stock: 600 },
    ],
  },
];
