import { createTestSeller } from './seller.js';

const port = Number(process.env.SELLER_PORT ?? 4100);
const seller = createTestSeller();
const base = await seller.start(port);
console.log(`Test seller running at ${base}  (release controls: ${base}/admin)`);
