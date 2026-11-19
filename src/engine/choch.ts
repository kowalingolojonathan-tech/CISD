import type { Candle, CisdSignal } from './types.ts';

/**
 * Adaptation of LuxAlgo Fractal Market Structure CHoCH/BOS logic.
 * Attribution: LuxAlgo. Source script license: CC BY-NC-SA 4.0.
 * This project uses the fractal/structure logic and emits CHoCH only.
 *
 * LuxAlgo-style fractal Market Structure detector (length=5, p=2).
 * BOS updates directional structure state but is never emitted as a trade signal.
 * Only a genuine change of character (break against the previous structure) is returned.
 */
export class ChochEngine {
  private bars: Candle[] = [];
  private upper: { value: number; index: number } | null = null;
  private lower: { value: number; index: number } | null = null;
  private os: -1 | 0 | 1 = 0;
  private sequence = 0;
  private trends: number[] = [];

  public reset() {
    this.bars = [];
    this.upper = null;
    this.lower = null;
    this.os = 0;
    this.sequence = 0;
    this.trends = [];
  }

  private sign(v: number): number { return v > 0 ? 1 : v < 0 ? -1 : 0; }

  private detect(bar: Candle, commit: boolean): CisdSignal | null {
    const bars = [...this.bars];
    const index = bars.length;
    bars.push(bar);
    let upper = this.upper ? { ...this.upper } : null;
    let lower = this.lower ? { ...this.lower } : null;
    let os = this.os;

    const length = 5;
    const p = 2;
    if (index >= length - 1) {
      const pivot = index - p;
      const window = bars.slice(index - length + 1, index + 1);
      const pivotBar = bars[pivot];
      const sumSigns = (end: number, field: 'high' | 'low') => {
        let sum = 0;
        for (let j = end - p + 1; j <= end; j++) {
          sum += this.sign(bars[j][field] - bars[j - 1][field]);
        }
        return sum;
      };
      const dh = sumSigns(index, 'high');
      const dl = sumSigns(index, 'low');
      const dhAtPivot = sumSigns(pivot, 'high');
      const dlAtPivot = sumSigns(pivot, 'low');
      const highest = Math.max(...window.map((b) => b.high));
      const lowest = Math.min(...window.map((b) => b.low));
      const bullf = dh === -p && dhAtPivot === p && pivotBar.high === highest;
      const bearf = dl === p && dlAtPivot === -p && pivotBar.low === lowest;
      if (bullf) upper = { value: pivotBar.high, index: pivot };
      if (bearf) lower = { value: pivotBar.low, index: pivot };
    }

    const prevClose = index > 0 ? bars[index - 1].close : bar.open;
    let signal: CisdSignal | null = null;
    if (upper && prevClose <= upper.value && bar.close > upper.value) {
      const isChoch = os === -1;
      if (isChoch) {
        signal = {
          id: `choch_bull_${bar.time}_${this.sequence + 1}`, barIndex: index, time: bar.time,
          direction: 'bullish', originLevel: upper.value, originBarIndex: upper.index,
          noiseRatio: 0, toleranceUsed: 0, strongSweep: false, wickedSwingLevel: null,
          barsSinceSwing: null, closePrice: bar.close,
        };
      }
      os = 1; // BOS or CHoCH both update the structure direction, as in LuxAlgo.
    }
    if (lower && prevClose >= lower.value && bar.close < lower.value) {
      const isChoch = os === 1;
      if (isChoch) {
        signal = {
          id: `choch_bear_${bar.time}_${this.sequence + 1}`, barIndex: index, time: bar.time,
          direction: 'bearish', originLevel: lower.value, originBarIndex: lower.index,
          noiseRatio: 0, toleranceUsed: 0, strongSweep: false, wickedSwingLevel: null,
          barsSinceSwing: null, closePrice: bar.close,
        };
      }
      os = -1;
    }

    if (commit) {
      this.bars.push(bar);
      this.upper = upper;
      this.lower = lower;
      this.os = os;
      this.trends.push(os);
      if (signal) this.sequence++;
    }
    return signal;
  }

  public processConfirmedBar(bar: Candle): CisdSignal | null {
    return this.detect({ ...bar, confirmed: true }, true);
  }

  public previewLiveBar(bar: Candle): CisdSignal | null {
    return this.detect({ ...bar, confirmed: false }, false);
  }

  public getCurrentTrend(): number { return this.os; }
  public getCandleTrends(): number[] { return [...this.trends]; }
}
