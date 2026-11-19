import assert from 'node:assert/strict';
import { nyCalendarDayDistance } from '../src/engine/killzones.ts';

const auto = 'Auto (DST)' as const;
const utc = (iso: string) => new Date(iso).getTime();

assert.equal(nyCalendarDayDistance(utc('2026-11-18T17:00:00Z'), utc('2026-11-19T17:00:00Z'), auto), 1);
assert.equal(nyCalendarDayDistance(utc('2026-11-17T17:00:00Z'), utc('2026-11-19T17:00:00Z'), auto), 2);
assert.equal(nyCalendarDayDistance(utc('2026-11-16T17:00:00Z'), utc('2026-11-19T17:00:00Z'), auto), 3);
assert.equal(nyCalendarDayDistance(utc('2026-03-07T17:00:00Z'), utc('2026-03-09T17:00:00Z'), auto), 2);
console.log('Session level age tests passed');
