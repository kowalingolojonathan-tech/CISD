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
  highProbabilityOnly: false, telegramBotToken: 'TKN', telegramChatId: '42', customWebhookUrl: '',
  alertsEnabled: true, repeatAlertIntervalSec: 30, liveSetupMaxMinutes: 20,
};

let tgResolvedAt = 0; let notifiedAt = 0; const notified: number[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any) => {
  if (String(url).includes('api.telegram.org')) {
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

// same setup must not fire twice when the bar closes
await eng.ingestLiveBar({ ...liveC, confirmed: true }, true);
ok(eng.getSnapshot().confluenceAlerts.filter((a) => a.dedupeKey === alert.dedupeKey).length === 1, 'no duplicate alert on bar close');
ok(notified.length === 1, 'no second push on bar close');

// ack stops reminders
eng.acknowledgeAlert(alert?.id??"", 'ui');
ok(eng.getSnapshot().confluenceAlerts[0].ackStatus === 'acknowledged', 'ack in app works');
console.log(checks.join('\n'));
