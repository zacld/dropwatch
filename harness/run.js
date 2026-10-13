// node harness/run.js [runs] [seed]
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runHarness } from './harness.js';

const runs = Number(process.argv[2] ?? 200);
const seed = Number(process.argv[3] ?? 1);
const pct = x => (x * 100).toFixed(1) + '%';

console.log(`Running ${runs} simulated releases (seed ${seed})…`);
const started = Date.now();
const r = await runHarness({ runs, seed, concurrency: 10 });
const file = join(dirname(fileURLToPath(import.meta.url)), 'report.json');
writeFileSync(file, JSON.stringify(r, null, 2));

console.log(`\nFinished in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
console.log('Outcome                                     Runs');
for (const [k, v] of Object.entries(r.outcomes).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(42)}${String(v).padStart(4)}`);
console.log(`\nSecured overall:                ${pct(r.securedRate)}`);
console.log(`Workflow reliability:           ${pct(r.workflowReliability)}  (secured ÷ attempts the workflow itself decided)`);
console.log(`Checkout submissions / orders:  ${r.checkoutSubmissions} / ${r.ordersPlaced}  (the gap is declined payments)`);
console.log(`Late waiting-room joins:        ${r.lateJoins}`);
console.log(`Hard-rule violations:           ${r.violations.length}`);
r.violations.slice(0, 20).forEach(v => console.log('  ✗ ' + v));
r.workflowErrors.slice(0, 20).forEach(e => console.log(`  workflow error, run ${e.run}: ${e.reason}`));
console.log(`\nReport written to ${file}`);
process.exit(r.violations.length || r.workflowErrors.length ? 1 : 0);
