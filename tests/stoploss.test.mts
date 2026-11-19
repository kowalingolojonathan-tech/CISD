import { TradingConfluenceEngine } from '../src/engine/confluence.ts';
import type { Candle, EngineConfig, KillzoneSweepEvent, CisdSignal } from '../src/engine/types.ts';

const now = Date.UTC(2026, 10, 17, 15, 0); // 10:00 New York, EST
const cfg: EngineConfig = {
  symbol: 'EUR/USD', marketSource: 'yahoo_swissquote', twelveDataApiKey: '', tzMode: 'Manual UTC-5 (EST)',
  tolerance: 0.7, swingPeriod: 12, expiryBars: 100, liquidityLookback: 10, kzLookbackBars: 10,
  requireActiveKillzone: true, triggerOnIntrabar: true, dailyBiasMode: 'BEARISH', h4BiasMode: 'BEARISH',
  highProbabilityOnly: false, enableM5Cisd: true, telegramBotToken: '', telegramChatId: '', customWebhookUrl: '',
  alertsEnabled: true, repeatAlertIntervalSec: 30, liveSetupMaxMinutes: 20,
};
const sweep: KillzoneSweepEvent = {
  id: 'sw1', levelId: 'london-high-1', sessionId: 'london', sessionName: 'London', shortName: 'L',
  isHigh: true, level: 1.0950, createdAt: now - 24 * 60 * 60_000, sweptAt: now - 60_000,
  sweptBarIndex: 1, sweepPrice: 1.0960,
};
const cisd = (time: number): CisdSignal => ({
  id: `cisd-${time}`, barIndex: 10, time, direction: 'bearish', originLevel: 1.0955,
  originBarIndex: 9, noiseRatio: 0.9, toleranceUsed: 0.7, strongSweep: true,
  wickedSwingLevel: 1.0960, barsSinceSwing: 1, closePrice: 1.0920,
});
const bar = (time: number, high: number): Candle => ({
  time, open: 1.0930, high, low: 1.0910, close: 1.0920, confirmed: true,
});
const engine = new TradingConfluenceEngine(cfg);
(engine as any).kzEngine.getSweepEvents = () => [sweep];
const first = (engine as any).evaluateConfluence(bar(now, 1.0961), 10, cisd(now), sweep, null, false, 'M3');
if (!first || first.stopLoss !== 1.0960) throw new Error('SL must be the highest bearish sweep wick');
first.ackStatus = 'pending';
(engine as any).confluenceAlerts.unshift(first);
(engine as any).invalidateStoppedSetups(bar(now + 3 * 60_000, 1.0960));
if (first.ackStatus !== 'invalidated' || first.nextReminderAt !== null) throw new Error('SL touch must invalidate setup and stop reminders');
if (first.retryUntil !== now + 63 * 60_000) throw new Error('Retry window must last 60 minutes after SL touch');
const retry = (engine as any).evaluateConfluence(bar(now + 6 * 60_000, 1.0950), 12, cisd(now + 6 * 60_000), sweep, null, false, 'M3');
if (!retry) throw new Error('A replacement CISD within the 60-minute window must be accepted');
const tooLate = (engine as any).evaluateConfluence(bar(now + 64 * 60_000, 1.0950), 13, cisd(now + 64 * 60_000), sweep, null, false, 'M3');
if (tooLate !== null) throw new Error('The old sweep must be rejected after the 60-minute retry window');

// Historical/backfilled alerts must not reserve live setups in any session.
for (const [sessionId, sessionName, shortName] of [
  ['asia', 'Asia', 'A'], ['london', 'London', 'L'],
  ['nyam', 'NY AM', 'NA'], ['nypm', 'NY PM', 'NP'],
] as const) {
  const sessionSweep: KillzoneSweepEvent = {
    ...sweep, id: `sw-${sessionId}`, levelId: `${sessionId}-high`,
    sessionId, sessionName, shortName,
  };
  const historicalEngine = new TradingConfluenceEngine(cfg);
  (historicalEngine as any).kzEngine.getSweepEvents = () => [sessionSweep];
  const historical = (historicalEngine as any).evaluateConfluence(
    bar(now, 1.0961), 10, cisd(now), sessionSweep, null, false, 'M3'
  );
  if (!historical) throw new Error(`Historical fixture must be created for ${sessionName}`);
  historical.ackStatus = 'historical';
  (historicalEngine as any).confluenceAlerts.unshift(historical);
  const liveAfterHistory = (historicalEngine as any).evaluateConfluence(
    bar(now + 3 * 60_000, 1.0950), 11, cisd(now + 3 * 60_000), sessionSweep, null, true, 'M3'
  );
  if (!liveAfterHistory) throw new Error(`Historical ${sessionName} alert blocked a fresh live CISD`);
}

// A bearish CISD cannot use a swept low; direction must match the liquidity side.
const oppositeEngine = new TradingConfluenceEngine(cfg);
const sweptLow: KillzoneSweepEvent = {
  ...sweep, id: 'sw-low', levelId: 'london-low-1', isHigh: false,
  level: 1.0900, sweepPrice: 1.0890,
};
(oppositeEngine as any).kzEngine.getSweepEvents = () => [sweptLow];
const wrongDirection = (oppositeEngine as any).evaluateConfluence(
  bar(now + 3 * 60_000, 1.0950), 11, cisd(now + 3 * 60_000), sweptLow, null, true, 'M3'
);
if (wrongDirection !== null) throw new Error('A bearish CISD must not qualify from a swept low');

// A genuinely fresh sweep (new source-level ID) can start a new setup after expiry.
const freshSweep: KillzoneSweepEvent = {
  ...sweep, id: 'sw2', levelId: 'london-high-2', sweptAt: now + 65 * 60_000,
  createdAt: now + 60 * 60_000, sweptBarIndex: 20, sweepPrice: 1.0970,
};
(engine as any).kzEngine.getSweepEvents = () => [sweep, freshSweep];
const freshSetup = (engine as any).evaluateConfluence(
  bar(now + 66 * 60_000, 1.0971), 21, cisd(now + 66 * 60_000), freshSweep, null, true, 'M3'
);
if (!freshSetup) throw new Error('A fresh sweep must start a new setup after the old retry window expires');

console.log('PASS  wick-based stop loss, invalidation, reminder stop, 60-minute retry and expiry');
