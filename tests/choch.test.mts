import { ChochEngine } from '../src/engine/choch.ts';
import type { Candle } from '../src/engine/types.ts';
const engine = new ChochEngine();
const bars: Candle[] = [
  { time: 1, open: 2, high: 2, low: 4, close: 2 },
  { time: 2, open: 2, high: 3, low: 3, close: 2.5 },
  { time: 3, open: 2.5, high: 6, low: 2.5, close: 4.5 },
  { time: 4, open: 4.5, high: 5, low: 2, close: 4 },
  { time: 5, open: 4, high: 4.5, low: 3, close: 4 },
  { time: 6, open: 4, high: 4, low: 2, close: 3.8 },
  { time: 7, open: 3.8, high: 4, low: 1, close: 3.2 },
  { time: 8, open: 3.2, high: 4.2, low: 2, close: 3.5 },
  { time: 9, open: 3.5, high: 4.3, low: 3, close: 3.8 },
  { time: 10, open: 3.8, high: 4, low: 0.5, close: 0.8 },
  { time: 11, open: 0.8, high: 6.5, low: 0.7, close: 6.2 },
];
const signals = bars.map((bar) => engine.processConfirmedBar(bar)).filter(Boolean);
if (signals.length !== 1 || signals[0]?.direction !== 'bullish') throw new Error('Expected one bullish CHoCH after bearish structure state');
if (!String(signals[0]?.id).startsWith('choch_bull_')) throw new Error('Expected LuxAlgo CHoCH id');
const independentM2 = new ChochEngine();
const independentM3 = new ChochEngine();
for (const item of bars.slice(0, -1)) independentM2.processConfirmedBar(item);
const preview = independentM2.previewLiveBar(bars[bars.length - 1]);
if (preview?.direction !== 'bullish' || independentM2.getCurrentTrend() !== -1) throw new Error('Live preview must not mutate the M2 structure state');
const confirmed = independentM2.processConfirmedBar(bars[bars.length - 1]);
if (confirmed?.direction !== 'bullish' || independentM3.getCurrentTrend() !== 0) throw new Error('M2 and M3 structure engines must be independent');
const inverse = new ChochEngine();
const bearishBars = bars.map((b) => ({ ...b, open: 10 - b.open, high: 10 - b.low, low: 10 - b.high, close: 10 - b.close }));
const bearishSignals = bearishBars.map((item) => inverse.processConfirmedBar(item)).filter(Boolean);
if (bearishSignals.length !== 1 || bearishSignals[0]?.direction !== 'bearish') throw new Error('Expected bearish CHoCH in the inverse structure');
console.log('PASS LuxAlgo fractal CHoCH: bullish/bearish reversals, BOS ignored, preview non-mutating, M2/M3 independent');
