import { TradingConfluenceEngine } from '../src/engine/confluence.ts';
import { MarketLiveFeed } from '../src/engine/marketFeed.ts';
import type { EngineConfig } from '../src/engine/types.ts';

const checks: string[] = [];
const ok = (c: boolean, m: string) => { checks.push(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };

const NOW = Date.UTC(2026, 10, 17, 14, 31, 10);
Date.now = () => NOW;

function yahooBody(price: number) {
  const ts: number[] = []; const o: number[] = []; const h: number[] = []; const l: number[] = []; const c: number[] = [];
  for (let m = 400; m >= 0; m--) {
    const t = Math.floor(NOW / 60000) * 60 - m * 60;
    const p = price + Math.sin(m / 9) * 2;
    ts.push(t); o.push(p); h.push(p + 0.6); l.push(p - 0.6); c.push(p + 0.1);
  }
  return { chart: { result: [{ timestamp: ts, indicators: { quote: [{ open: o, high: h, low: l, close: c, volume: ts.map(() => 0) }] } }] } };
}

function makeEngine(): TradingConfluenceEngine {
  const cfg: EngineConfig = {
    symbol: 'XAU/USD', marketSource: 'yahoo_swissquote', twelveDataApiKey: '', tzMode: 'Auto (DST)',
    tolerance: 0.7, swingPeriod: 12, expiryBars: 100, liquidityLookback: 10, kzLookbackBars: 10,
    requireActiveKillzone: true, triggerOnIntrabar: true, dailyBiasMode: 'AUTO', h4BiasMode: 'AUTO',
    highProbabilityOnly: false, enableM5Cisd: true, telegramBotToken: '', telegramChatId: '', customWebhookUrl: '',
    alertsEnabled: true, repeatAlertIntervalSec: 30, liveSetupMaxMinutes: 20,
  };
  return new TradingConfluenceEngine(cfg);
}

let spot = 4000.0; const calls: string[] = []; let spotDelay = 0; let spotInFlight = 0; let spotMaxParallel = 0;
let spotUp = true; let yahooSpotTickerWorks = false;
globalThis.fetch = (async (url: any, init: any) => {
  const u = String(url); calls.push(u);
  if (init?.signal === undefined) throw new Error('fetch without timeout signal: ' + u);
  if (u.includes('swissquote')) {
    spotInFlight++; spotMaxParallel = Math.max(spotMaxParallel, spotInFlight);
    await new Promise((r) => setTimeout(r, spotDelay));
    spotInFlight--;
    if (!spotUp) return new Response('{}', { status: 503 });
    return new Response(JSON.stringify([{ spreadProfilePrices: [{ spreadProfile: 'prime', bid: spot - 0.2, ask: spot + 0.2 }] }]), { status: 200 });
  }
  if (u.includes('XAUUSD%3DX') || u.includes('XAUUSD=X')) {
    return yahooSpotTickerWorks ? new Response(JSON.stringify(yahooBody(4000)), { status: 200 }) : new Response('nope', { status: 404 });
  }
  if (u.includes('GC%3DF') || u.includes('GC=F')) return new Response(JSON.stringify(yahooBody(4040)), { status: 200 }); // futures ~40 above spot
  throw new Error('unexpected ' + u);
}) as any;

// ---- 1. spot ticker unavailable -> GC=F fallback must be re-based on spot ----
const eng = makeEngine();
const feed = new MarketLiveFeed(eng, 'XAU/USD');
await feed.reload(); (feed as any).isRunning = true;
let snap = eng.getSnapshot();
const lastClose = snap.candles[snap.candles.length - 1].close;
ok(snap.feedStatus.connected, 'feed connected via fallback');
ok(Math.abs(lastClose - 4000) < 5, `futures bars re-based to spot: last close ${lastClose} (raw futures ~4040)`);
ok(calls.some((c) => c.includes('XAUUSD')) && calls.some((c) => c.includes('GC')), 'tried spot ticker first, then GC=F');

// ---- 2. a spot tick must not be polluted by anything ----
spot = 4003.0;
await (feed as any).pollSpotTick();
snap = eng.getSnapshot();
const live = snap.candles[snap.candles.length - 1];
ok(live.close === 4003, `live bar follows spot tick (${live.close})`);
ok(live.high < 4010, `live high not polluted by futures prices (${live.high})`);

// ---- 3. no overlapping polls ----
spotDelay = 200; spotMaxParallel = 0;
await Promise.all([ (feed as any).pollSpotTick(), (feed as any).pollSpotTick(), (feed as any).pollSpotTick() ]);
ok(spotMaxParallel === 1, `polls never overlap (max parallel = ${spotMaxParallel})`);
spotDelay = 0;

// ---- 4. history sync must not merge Yahoo live bar while spot is healthy ----
await (feed as any).pollSpotTick();
const before = eng.getSnapshot().candles.at(-1)!;
await (feed as any).syncLatestBars();
const after = eng.getSnapshot().candles.at(-1)!;
ok(after.high === before.high && after.close === before.close, `sync leaves the spot-built live bar untouched (high ${before.high} -> ${after.high})`);

// ---- 5. spot down: Yahoo live bar takes over, status stays honest ----
spotUp = false;
(feed as any).lastSpotOkAt = NOW - 60_000;
await (feed as any).syncLatestBars();
snap = eng.getSnapshot();
ok(snap.feedStatus.connected && /spot/i.test(snap.feedStatus.lastError ?? ''), `fallback to Yahoo when spot stale: "${snap.feedStatus.lastError}"`);

// ---- 6. spot ticker works -> no offset ----
yahooSpotTickerWorks = true; spotUp = true;
const eng2 = makeEngine(); const feed2 = new MarketLiveFeed(eng2, 'XAU/USD');
await feed2.reload();
const c2 = eng2.getSnapshot().candles.at(-1)!.close;
ok(Math.abs(c2 - 4000) < 5 && (feed2 as any).m3Offset === 0, `spot ticker used as-is, no offset (close ${c2})`);
console.log(checks.join('\n'));
process.exit(process.exitCode ?? 0);
