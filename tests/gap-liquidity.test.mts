import { KillzonesEngine } from '../src/engine/killzones.ts';
import type { Candle } from '../src/engine/types.ts';
const tz = 'Manual UTC-5 (EST)' as const;
const utc = (h: number, m: number) => Date.UTC(2026, 10, 18, h + 5, m);
const bar = (time: number, high: number, low: number): Candle => ({ time, open: (high + low) / 2, high, low, close: (high + low) / 2, confirmed: true });
const kz = new KillzonesEngine(tz);
kz.processBar(bar(utc(20, 0), 1.0990, 1.0910), 0); // Asia begins
kz.processBar(bar(utc(23, 57), 1.1000, 1.0900), 1); // Asia range final high/low
kz.processBar(bar(utc(0, 0), 1.0990, 1.0910), 2); // Asia ends, levels created
const breakEvents = kz.processBar(bar(utc(0, 30), 1.1010, 1.0920), 3); // Asia high broken in gap
if (!breakEvents.some((e) => e.isHigh)) throw new Error('Expected previous Asia high to be broken');
kz.processBar(bar(utc(1, 30), 1.1040, 1.0930), 4); // breakout leg extends before London
kz.processBar(bar(utc(2, 0), 1.1030, 1.0940), 5); // London begins, gap extreme becomes required liquidity
const pendingBeforeSession = kz.getPendingGapSourceSweepIds(utc(1, 30));
if (pendingBeforeSession.length !== 0) throw new Error('Historical bars before the next session must not be blocked');
const pendingAtSession = kz.getPendingGapSourceSweepIds(utc(2, 1));
if (pendingAtSession.length !== 1) throw new Error('Gap source should be blocked only after the next session begins');
const pending = kz.getPendingGapSourceSweepIds();
if (pending.length !== 1 || pending[0] !== breakEvents[0].id) throw new Error('Expected source sweep blocked until gap liquidity is swept');
const gapSweep = kz.processBar(bar(utc(2, 3), 1.1045, 1.0950), 6);
if (!gapSweep.some((e) => e.isGapLiquidity && e.sourceSweepId === breakEvents[0].id)) throw new Error('Expected London to sweep the gap liquidity');
if (kz.getPendingGapSourceSweepIds().length !== 0 || kz.getPendingGapSourceSweepIds(utc(2, 4)).length !== 0) throw new Error('Gap source should be released after gap liquidity sweep');
console.log('PASS inter-session breakout liquidity is required and swept by the next session');
