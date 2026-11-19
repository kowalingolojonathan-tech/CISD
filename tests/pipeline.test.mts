import { TradingConfluenceEngine } from '../src/engine/confluence.ts';
import type { EngineConfig, KillzoneSweepEvent, CisdSignal } from '../src/engine/types.ts';

const checks: string[] = [];
const ok = (c: boolean, m: string) => { checks.push(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
const NOW = Date.UTC(2026, 10, 17, 14, 30, 0);
Date.now = () => NOW;
const cfg: EngineConfig = {
  symbol: 'EUR/USD', marketSource: 'yahoo_swissquote', twelveDataApiKey: '', tzMode: 'Manual UTC-5 (EST)',
  tolerance: 0.7, swingPeriod: 12, expiryBars: 100, liquidityLookback: 10, kzLookbackBars: 10,
  requireActiveKillzone: true, triggerOnIntrabar: true, dailyBiasMode: 'BEARISH', h4BiasMode: 'BEARISH',
  highProbabilityOnly: false, enableM2Choch: true, telegramBotToken: 'TKN', telegramChatId: '42', customWebhookUrl: '',
  alertsEnabled: true, repeatAlertIntervalSec: 30, liveSetupMaxMinutes: 20,
};
const sweep = (id: string, sweptAt = NOW - 60_000): KillzoneSweepEvent => ({
  id, levelId: `level_${id}`, sessionId: 'london', sessionName: 'London', shortName: 'L', isHigh: true,
  level: 1.0950, createdAt: NOW - 60 * 60_000, sweptAt, sweptBarIndex: 1, sweepPrice: 1.0960,
});
const choch = (time = NOW): CisdSignal => ({
  id: `choch_${time}`, barIndex: 3, time, direction: 'bearish', originLevel: 1.0940,
  originBarIndex: 2, noiseRatio: 0, toleranceUsed: 0, strongSweep: false,
  wickedSwingLevel: null, barsSinceSwing: null, closePrice: 1.0955,
});
const bar = (time = NOW) => ({ time, open: 1.0960, high: 1.0962, low: 1.0940, close: 1.0955, confirmed: true });

let telegramCalls = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (url: any) => {
  if (String(url).includes('api.telegram.org')) {
    telegramCalls++;
    return new Response(JSON.stringify({ ok: true, result: { message_id: telegramCalls } }), { status: 200 });
  }
  return realFetch(url);
}) as any;

const engine = new TradingConfluenceEngine(cfg);
const kz = (engine as any).kzEngine;
kz.getSweepEvents = () => [sweep('london_high')];
let notifierCalls = 0;
engine.setAlertNotifier((_alert, n) => { if (n === 1) notifierCalls++; });
const alert = (engine as any).evaluateConfluence(bar(), 3, choch(), sweep('london_high'), null, true, 'M3');
ok(!!alert && alert.direction === 'BEARISH' && alert.timeframe === 'M3', 'M3 bearish CHoCH matches only a swept session high');
ok(alert?.isPreReentry === true, 'CHoCH before price re-enters the broken session level is accepted');
ok(alert?.sweepTimeStr?.includes('2026-11-17') && alert?.chochTimeStr?.includes('2026-11-17'), 'alert captures full NY date and time for sweep and CHoCH');
ok(alert?.reentryAt === null && alert?.reentryPrice === null, 'alert records no re-entry when price has not closed back inside before CHoCH');
const reenteredEngine = new TradingConfluenceEngine(cfg);
(reenteredEngine as any).kzEngine.getSweepEvents = () => [sweep('london_high', NOW - 60_000)];
(reenteredEngine as any).confirmedBars = [{ ...bar(NOW - 30_000), close: 1.0945 }];
const afterReentry = (reenteredEngine as any).evaluateConfluence(bar(), 3, choch(), sweep('london_high', NOW - 60_000), null, false, 'M3');
ok(afterReentry?.isPreReentry === false && afterReentry?.reentryAt === NOW - 30_000 && afterReentry?.reentryPrice === 1.0945, 'alert captures the first re-entry candle time and close price before CHoCH');
await (engine as any).recordAndDispatchAlert(alert, true);
ok(engine.getSnapshot().confluenceAlerts[0]?.ackStatus === 'pending', 'live CHoCH enters pending validation');
ok(notifierCalls === 1 && telegramCalls === 1, 'one app notification hook and one Telegram delivery');

for (let delivery = 2; delivery <= 10; delivery++) {
  Date.now = () => NOW + (delivery - 1) * 30_000;
  await engine.processPendingReminders();
}
ok(telegramCalls === 10 && engine.getSnapshot().confluenceAlerts[0].reminderCount === 10, '10 total Telegram deliveries including the initial alert');
Date.now = () => NOW + 400_000;
await engine.processPendingReminders();
ok(telegramCalls === 10, 'reminders stop at the 10-delivery limit');
engine.acknowledgeAlert(alert.id, 'ui');
Date.now = () => NOW + 500_000;
await engine.processPendingReminders();
ok(engine.getSnapshot().confluenceAlerts[0].ackStatus === 'acknowledged' && telegramCalls === 10, 'J’ai vu stops reminders');

// Daily/H4 classification is informational and does not suppress contrary setups.
Date.now = () => NOW;
const divergent = new TradingConfluenceEngine({ ...cfg, dailyBiasMode: 'BULLISH', h4BiasMode: 'BEARISH', highProbabilityOnly: true });
(divergent as any).kzEngine.getSweepEvents = () => [sweep('divergent_high')];
const medium = (divergent as any).evaluateConfluence(bar(), 3, choch(), sweep('divergent_high'), null, false, 'M2');
ok(medium?.probability === 'MEDIUM' && medium.timeframe === 'M2', 'one aligned HTF gives MEDIUM and M2 remains eligible');
const contraryEngine = new TradingConfluenceEngine({ ...cfg, dailyBiasMode: 'BULLISH', h4BiasMode: 'BULLISH' });
(contraryEngine as any).kzEngine.getSweepEvents = () => [sweep('contrary_high')];
const contrary = (contraryEngine as any).evaluateConfluence(bar(), 3, choch(), sweep('contrary_high'), null, false, 'M3');
ok(contrary?.probability === 'COUNTER_TREND', 'both HTFs opposed classify as CONTRARY without suppressing the signal');

// Only the latest responsible sweep is attached; older unrelated session levels are excluded.
const multi = new TradingConfluenceEngine(cfg);
const oldSweep = sweep('old_session', NOW - 90_000);
const latestSweep = sweep('latest_session', NOW - 30_000);
(multi as any).kzEngine.getSweepEvents = () => [oldSweep, latestSweep];
const latestOnly = (multi as any).evaluateConfluence(bar(), 3, choch(), latestSweep, null, false, 'M2');
ok(latestOnly?.kzSweeps.length === 1 && latestOnly.kzSweep.id === 'latest_session', 'alert history lists only the latest sweep responsible for the CHoCH');

const gapGateEngine = new TradingConfluenceEngine(cfg);
const sourceBreak = sweep('source_break');
(gapGateEngine as any).kzEngine.getSweepEvents = () => [sourceBreak];
(gapGateEngine as any).kzEngine.getPendingGapSourceSweepIds = () => ['source_break'];
const blockedBeforeGapSweep = (gapGateEngine as any).evaluateConfluence(bar(), 3, choch(), sourceBreak, null, false, 'M2');
ok(blockedBeforeGapSweep === null, 'a new session cannot use the old breakout before sweeping the intermediate gap liquidity');
(gapGateEngine as any).kzEngine.getPendingGapSourceSweepIds = () => [];
const gapSweep = { ...sweep('gap_sweep', NOW - 30_000), id: 'gap_sweep', levelId: 'gap_level', shortName: 'GAP', sessionName: 'Gap London → NY AM', isGapLiquidity: true, sourceSweepId: 'source_break' };
(gapGateEngine as any).kzEngine.getSweepEvents = () => [sourceBreak, gapSweep];
const afterGapSweep = (gapGateEngine as any).evaluateConfluence(bar(), 3, choch(), gapSweep, null, false, 'M2');
ok(afterGapSweep?.kzSweep.isGapLiquidity === true, 'the gap-liquidity sweep becomes the responsible setup source');

const nextDay = new TradingConfluenceEngine(cfg);
(nextDay as any).kzEngine.getSweepEvents = () => [sweep('previous_day', Date.UTC(2026, 10, 17, 14, 30))];
const nextDayResult = (nextDay as any).evaluateConfluence(bar(Date.UTC(2026, 10, 18, 14, 30)), 3, choch(Date.UTC(2026, 10, 18, 14, 30)), sweep('previous_day', Date.UTC(2026, 10, 17, 14, 30)), null, false, 'M3');
ok(nextDayResult === null, 'a sweep from the previous New York day cannot justify a new-day CHoCH');

console.log(checks.join('\n'));
globalThis.fetch = realFetch;
