import { TradingConfluenceEngine } from '../src/engine/confluence.ts';
import type { Candle, EngineConfig } from '../src/engine/types.ts';

const checks: string[] = [];
const ok = (c: boolean, m: string) => { checks.push(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };

// "now" = Tue 2026-11-17 14:30 UTC = 09:30 EST -> NY AM killzone (08:30-11:00) is active
const NOW = Date.UTC(2026, 10, 17, 14, 30, 0);
Date.now = () => NOW;
const M3 = 180_000;
const t = (h: number, m: number) => Date.UTC(2026, 10, 17, h, m);

const bars: Candle[] = [];
const push = (time: number, o: number, h: number, l: number, c: number) =>
  bars.push({ time, open: o, high: h, low: l, close: c, volume: 0, confirmed: true });

// Quiet tape from 05:00 UTC; London (07:00-10:00 UTC) tops out at 1.0950
for (let ts = t(5, 0); ts < t(14, 12); ts += M3) {
  const hr = new Date(ts).getUTCHours();
  const base = 1.0900 + ((ts / M3) % 7) * 0.0001;
  const londonSpike = hr === 8 && new Date(ts).getUTCMinutes() === 30;
  const up = (ts / M3) % 2 === 0;
  push(ts, up ? base : base + 0.0003, Math.max(base, base + 0.0003) + (londonSpike ? 0.0047 : 0.0002), Math.min(base, base + 0.0003) - 0.0002, up ? base + 0.0003 : base);
}
// 14:18 A (bearish), 14:21 B (bullish delivery that wicks ABOVE London high), then live C reverses
push(t(14, 12), 1.0905, 1.0931, 1.0904, 1.0930);   // bullish, ends the previous run
push(t(14, 15), 1.0930, 1.0931, 1.0924, 1.0925);   // bearish run going DOWN
push(t(14, 18), 1.0925, 1.0926, 1.0919, 1.0920);
push(t(14, 21), 1.0920, 1.0958, 1.0919, 1.0954);   // sweep of London high 1.0950
const liveC: Candle = { time: t(14, 24), open: 1.0954, high: 1.0955, low: 1.0913, close: 1.0915, volume: 0, confirmed: false };

const cfg: EngineConfig = {
  symbol: 'EUR/USD', marketSource: 'yahoo_swissquote', twelveDataApiKey: '', tzMode: 'Manual UTC-5 (EST)',
  tolerance: 0.7, swingPeriod: 12, expiryBars: 100, liquidityLookback: 10, kzLookbackBars: 10,
  requireActiveKillzone: true, triggerOnIntrabar: true, dailyBiasMode: 'BEARISH', h4BiasMode: 'BEARISH',
  highProbabilityOnly: false, enableM5Cisd: true, telegramBotToken: 'TKN', telegramChatId: '42', customWebhookUrl: '',
  alertsEnabled: true, repeatAlertIntervalSec: 30, liveSetupMaxMinutes: 20,
};

let tgResolvedAt = 0; let notifiedAt = 0; let telegramCalls = 0; const notified: number[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any) => {
  if (String(url).includes('api.telegram.org')) {
    telegramCalls += 1;
    await new Promise((r) => setTimeout(r, 300));          // slow Telegram
    tgResolvedAt = performance.now();
    return new Response(JSON.stringify({ ok: true, result: { message_id: 9 } }), { status: 200 });
  }
  return realFetch(url);
}) as any;

const eng = new TradingConfluenceEngine(cfg);
eng.setAlertNotifier((_a, n) => { notifiedAt = performance.now(); notified.push(n); });

eng.loadHistory(bars, null);
const histAlerts = eng.getSnapshot().confluenceAlerts;
ok(histAlerts.every((a) => a.ackStatus === 'historical'), `history never dispatches (${histAlerts.length} historical alerts)`);
ok(notified.length === 0, 'no push for historical signals');

await eng.ingestLiveBar(liveC, false);
const snap = eng.getSnapshot();
const alert = snap.confluenceAlerts[0];
ok(!!alert, 'confluence alert created from sweep + CISD');
ok(alert?.direction === 'BEARISH' && alert?.kzSweep.sessionName === 'London' && alert?.kzSweep.isHigh, `BEARISH after London high sweep (${alert?.kzSweep.sessionName})`);
ok(alert?.probability === 'HIGH', 'HIGH probability (D1+H4 BEARISH aligned)');
ok(alert?.ackStatus === 'pending', 'alert is pending validation');
ok(alert?.isIntrabarSignal === true, 'fired intrabar (before M3 close)');
ok(notified.length === 1 && notified[0] === 1, 'push notifier called once (reminder #1)');
ok(notifiedAt > 0 && notifiedAt < tgResolvedAt, `push fired BEFORE Telegram answered (${(tgResolvedAt - notifiedAt).toFixed(0)} ms earlier)`);
ok(alert?.webhookStatus === 'sent', 'Telegram dispatch still completes');

// Telegram repeats at the configured interval, up to 10 deliveries total.
for (let delivery = 2; delivery <= 10; delivery++) {
  Date.now = () => NOW + (delivery - 1) * 30_000;
  await eng.processPendingReminders();
}
ok(telegramCalls === 10, `Telegram sends 10 deliveries total while unacknowledged (${telegramCalls})`);
ok(eng.getSnapshot().confluenceAlerts[0].reminderCount === 10, 'reminder counter reaches the 10-delivery cap');
Date.now = () => NOW + 400_000;
await eng.processPendingReminders();
ok(telegramCalls === 10, 'no more messages after the 10-delivery cap');

// same setup must not fire twice when the bar closes
Date.now = () => NOW;
await eng.ingestLiveBar({ ...liveC, confirmed: true }, true);
ok(eng.getSnapshot().confluenceAlerts.filter((a) => a.dedupeKey === alert.dedupeKey).length === 1, 'no duplicate alert on bar close');
ok(notified.length === 1, 'no second initial push on bar close');

// ack stops reminders immediately
eng.acknowledgeAlert(alert?.id??"", 'ui');
Date.now = () => NOW + 500_000;
await eng.processPendingReminders();
ok(eng.getSnapshot().confluenceAlerts[0].ackStatus === 'acknowledged', 'ack in app works');
ok(telegramCalls === 10, 'acknowledged alert never sends another Telegram reminder');
Date.now = () => NOW;
// Divergent Daily/H4 remains eligible even when legacy strict-alignment flag is true.
const divergent = new TradingConfluenceEngine({ ...cfg, dailyBiasMode: 'BULLISH', h4BiasMode: 'BEARISH', highProbabilityOnly: true });
divergent.loadHistory(bars, null);
await divergent.ingestLiveBar(liveC, false);
const divergentAlert = divergent.getSnapshot().confluenceAlerts[0];
ok(divergentAlert?.probability === 'MEDIUM' && divergentAlert.ackStatus === 'pending', 'Daily bullish / H4 bearish setup is still alerted even when legacy strict filter is true');

// One CISD can report several same-side session levels swept in the same setup.
const dualSweepEngine = new TradingConfluenceEngine(cfg);
const sweepA = { id: 'sw_nyam', levelId: 'nyam_high', sessionId: 'nyam' as const, sessionName: 'NY AM', shortName: 'NYA', isHigh: true, level: 1.0950, createdAt: NOW - 24 * 60 * 60_000, sweptAt: NOW - 60_000, sweptBarIndex: 1, sweepPrice: 1.0960 };
const sweepB = { id: 'sw_nypm', levelId: 'nypm_high', sessionId: 'nypm' as const, sessionName: 'NY PM', shortName: 'NYP', isHigh: true, level: 1.0940, createdAt: NOW - 24 * 60 * 60_000, sweptAt: NOW - 30_000, sweptBarIndex: 2, sweepPrice: 1.0960 };
(dualSweepEngine as any).kzEngine.getSweepEvents = () => [sweepA, sweepB];
const dualAlert = (dualSweepEngine as any).evaluateConfluence(
  { time: NOW, open: 1.0960, high: 1.0962, low: 1.0900, close: 1.0910, confirmed: true },
  3,
  { id: 'cisd_test', barIndex: 3, time: NOW, direction: 'bearish', originLevel: 1.0955, originBarIndex: 2, noiseRatio: 0.9, toleranceUsed: 0.7, strongSweep: true, wickedSwingLevel: 1.0960, barsSinceSwing: 1, closePrice: 1.0910 },
  sweepB, null, false, 'M5'
);
ok(dualAlert?.timeframe === 'M5' && dualAlert.kzSweeps.length === 2, 'M5 signal records both NY AM and NY PM swept highs');


// A Killzone sweep may produce its CISD later, including after a retest/re-entry,
// but the setup must expire at the end of that same New York calendar day.
const lateSweepEngine = new TradingConfluenceEngine(cfg);
const lateSweepAt = Date.UTC(2026, 10, 17, 14, 30); // 09:30 EST, inside NY AM
const lateSweep = { id: 'sw_late_day', levelId: 'nyam_high_late', sessionId: 'nyam' as const, sessionName: 'NY AM', shortName: 'NYA', isHigh: true, level: 1.0950, createdAt: Date.UTC(2026, 10, 16, 14, 30), sweptAt: lateSweepAt, sweptBarIndex: 1, sweepPrice: 1.0960 };
(lateSweepEngine as any).kzEngine.getSweepEvents = () => [lateSweep];
const lateDayCisd = (lateSweepEngine as any).evaluateConfluence(
  { time: Date.UTC(2026, 10, 17, 22, 30), open: 1.0960, high: 1.0962, low: 1.0900, close: 1.0910, confirmed: true },
  10,
  { id: 'cisd_late_day', barIndex: 10, time: Date.UTC(2026, 10, 17, 22, 30), direction: 'bearish', originLevel: 1.0955, originBarIndex: 2, noiseRatio: 0.9, toleranceUsed: 0.7, strongSweep: true, wickedSwingLevel: 1.0960, barsSinceSwing: 8, closePrice: 1.0910 },
  lateSweep, null, false, 'M5'
);
ok(!!lateDayCisd && lateDayCisd.timeframe === 'M5', 'CISD M5 after NY AM sweep is accepted after NY PM/Killzone close on the same NY day');

const nextDayEngine = new TradingConfluenceEngine(cfg);
(nextDayEngine as any).kzEngine.getSweepEvents = () => [lateSweep];
const nextDayCisd = (nextDayEngine as any).evaluateConfluence(
  { time: Date.UTC(2026, 10, 18, 14, 30), open: 1.0960, high: 1.0962, low: 1.0900, close: 1.0910, confirmed: true },
  11,
  { id: 'cisd_next_day', barIndex: 11, time: Date.UTC(2026, 10, 18, 14, 30), direction: 'bearish', originLevel: 1.0955, originBarIndex: 2, noiseRatio: 0.9, toleranceUsed: 0.7, strongSweep: true, wickedSwingLevel: 1.0960, barsSinceSwing: 9, closePrice: 1.0910 },
  lateSweep, null, false, 'M5'
);
ok(nextDayCisd === null, 'a previous NY-day sweep cannot trigger a CISD on the next NY day');

const outOfKillzoneSweepEngine = new TradingConfluenceEngine(cfg);
const outOfKillzoneSweep = { ...lateSweep, id: 'sw_outside_kz', levelId: 'nyam_high_outside', sweptAt: Date.UTC(2026, 10, 17, 22, 15) }; // 17:15 EST, after NY PM
(outOfKillzoneSweepEngine as any).kzEngine.getSweepEvents = () => [outOfKillzoneSweep];
const outOfKillzoneCisd = (outOfKillzoneSweepEngine as any).evaluateConfluence(
  { time: Date.UTC(2026, 10, 17, 22, 30), open: 1.0960, high: 1.0962, low: 1.0900, close: 1.0910, confirmed: true },
  12,
  { id: 'cisd_after_kz_sweep', barIndex: 12, time: Date.UTC(2026, 10, 17, 22, 30), direction: 'bearish', originLevel: 1.0955, originBarIndex: 2, noiseRatio: 0.9, toleranceUsed: 0.7, strongSweep: true, wickedSwingLevel: 1.0960, barsSinceSwing: 1, closePrice: 1.0910 },
  outOfKillzoneSweep, null, false, 'M5'
);
ok(!!outOfKillzoneCisd && outOfKillzoneCisd.timeframe === 'M5', 'a previously formed session level swept outside every Killzone can qualify on the same NY day');

console.log(checks.join('\n'));
