// node harness/skiddle-run.js [runs] [--watch]
//   --watch  opens Chrome on screen and runs one attempt per payment route slowly, so you can follow it
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runSkiddleHarness } from './skiddle-harness.js';

const watch = process.argv.includes('--watch');
const runs = Number(process.argv.find(a => /^\d+$/.test(a)) ?? (watch ? 3 : 12));
console.log(`Running ${runs} Skiddle attempts in Chrome against the local Skiddle copy${watch ? ' (on screen)' : ''}…\n`);
const r = await runSkiddleHarness({
  runs, concurrency: watch ? 1 : 3, headless: !watch, slowMo: watch ? 120 : 0, log: m => console.log('  ' + m),
});
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'skiddle-report.json'), JSON.stringify(r, null, 2));
console.log('\nOutcome                                     Runs');
for (const [k, v] of Object.entries(r.outcomes)) console.log(`  ${k.padEnd(42)}${String(v).padStart(4)}`);
console.log('\nBy payment route        runs  secured  needed the customer');
for (const [k, v] of Object.entries(r.byRoute)) console.log(`  ${k.padEnd(22)}${String(v.runs).padStart(5)}${String(v.secured).padStart(9)}${String(v.handoffs).padStart(12)}`);
console.log(`\nMedian attempt time: ${r.medianSeconds.toFixed(1)}s`);
console.log(`Hard-rule violations: ${r.violations.length}`);
r.violations.forEach(v => console.log('  ✗ ' + v));
r.workflowErrors.forEach(e => console.log(`  workflow error, run ${e.run} [${e.route}]: ${e.reason}`));
process.exit(r.violations.length || r.workflowErrors.length ? 1 : 0);
