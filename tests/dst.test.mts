import { resolveNyOffsetHours } from '../src/engine/killzones.ts';

function trueOffset(ms: number): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(new Date(ms));
  const g = (t: string) => Number(parts.find(p => p.type === t)!.value);
  const asUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour'), g('minute'));
  return Math.round((asUtc - ms) / 3600000);
}

let bad = 0; const badDays = new Set<string>();
for (const year of [2025, 2026, 2027]) {
  for (let ms = Date.UTC(year, 0, 1); ms < Date.UTC(year + 1, 0, 1); ms += 30 * 60000) {
    if (resolveNyOffsetHours(ms, 'Auto (DST)') !== trueOffset(ms)) {
      bad++; badDays.add(new Date(ms).toISOString().slice(0, 10));
    }
  }
}
console.log('mismatching half-hours:', bad);
console.log('days affected:', [...badDays].join(', '));
if (bad > 0) process.exitCode = 1; else console.log('PASS  DST offset matches America/New_York for 2025-2027');
