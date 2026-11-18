import type { Candle, CisdSignal, SwingPivot } from './types.ts';

interface PotentialEntry {
  open: number;
  barIndex: number;
}

interface ActiveSwingLine {
  id: string;
  x1: number;
  level: number;
  pivotRef: SwingPivot;
}

export interface CisdParams {
  tolerance: number;
  swingPeriod: number;
  expiryBars: number;
  liquidityLookback: number;
}

export class CisdEngine {
  private params: CisdParams;
  private bars: Candle[] = [];
  private candleTrends: number[] = [];
  private trend = 0;

  private swingHighs: ActiveSwingLine[] = [];
  private swingLows: ActiveSwingLine[] = [];
  private allPivots: SwingPivot[] = [];

  private lastWickedHighLevel: number | null = null;
  private lastWickedLowLevel: number | null = null;
  private lastWickedHighBar: number | null = null;
  private lastWickedLowBar: number | null = null;

  private bearPotential: PotentialEntry[] = [];
  private bullPotential: PotentialEntry[] = [];

  private cisdSignals: CisdSignal[] = [];
  private uidCounter = 0;

  constructor(params: CisdParams) {
    this.params = { ...params };
  }

  public reset(params?: CisdParams) {
    if (params) this.params = { ...params };
    this.bars = [];
    this.candleTrends = [];
    this.trend = 0;
    this.swingHighs = [];
    this.swingLows = [];
    this.allPivots = [];
    this.lastWickedHighLevel = null;
    this.lastWickedLowLevel = null;
    this.lastWickedHighBar = null;
    this.lastWickedLowBar = null;
    this.bearPotential = [];
    this.bullPotential = [];
    this.cisdSignals = [];
    this.uidCounter = 0;
  }

  /**
   * Processes one confirmed M3 candle sequentially, matching Pine Script v6 execution bar-by-bar.
   * Returns a CisdSignal if cisd == 1 or cisd == 2 triggered on this bar.
   */
  public processConfirmedBar(bar: Candle): CisdSignal | null {
    const barIndex = this.bars.length;
    this.bars.push(bar);

    const { tolerance, swingPeriod: len, expiryBars, liquidityLookback } = this.params;

    // 1. Pivot High / Low detection: ta.pivothigh(len, len), ta.pivotlow(len, len)
    if (barIndex >= len * 2) {
      const cIdx = barIndex - len;
      const candidateHigh = this.bars[cIdx].high;
      const candidateLow = this.bars[cIdx].low;

      let isPivHigh = true;
      let isPivLow = true;

      for (let j = cIdx - len; j <= cIdx + len; j++) {
        if (j === cIdx) continue;
        if (this.bars[j].high >= candidateHigh) {
          isPivHigh = false;
        }
        if (this.bars[j].low <= candidateLow) {
          isPivLow = false;
        }
        if (!isPivHigh && !isPivLow) break;
      }

      if (isPivHigh) {
        const piv: SwingPivot = {
          id: `piv_h_${++this.uidCounter}`,
          barIndex: cIdx,
          time: this.bars[cIdx].time,
          type: 'high',
          level: candidateHigh,
          mitigated: false,
          mitigatedAt: null,
          mitigatedBarIndex: null,
          expired: false,
        };
        this.allPivots.push(piv);
        this.swingHighs.unshift({ id: piv.id, x1: cIdx, level: candidateHigh, pivotRef: piv });
      }

      if (isPivLow) {
        const piv: SwingPivot = {
          id: `piv_l_${++this.uidCounter}`,
          barIndex: cIdx,
          time: this.bars[cIdx].time,
          type: 'low',
          level: candidateLow,
          mitigated: false,
          mitigatedAt: null,
          mitigatedBarIndex: null,
          expired: false,
        };
        this.allPivots.push(piv);
        this.swingLows.unshift({ id: piv.id, x1: cIdx, level: candidateLow, pivotRef: piv });
      }
    }

    // 2. Swing High / Low Mitigation & Expiry (barstate.isconfirmed)
    if (this.swingHighs.length > 0) {
      for (let i = this.swingHighs.length - 1; i >= 0; i--) {
        const l = this.swingHighs[i];
        if (barIndex - l.x1 < expiryBars) {
          if (bar.high >= l.level) {
            l.pivotRef.mitigated = true;
            l.pivotRef.mitigatedAt = bar.time;
            l.pivotRef.mitigatedBarIndex = barIndex;
            this.swingHighs.splice(i, 1);
            this.lastWickedHighLevel = l.level;
            this.lastWickedHighBar = barIndex;
          }
        } else {
          l.pivotRef.expired = true;
          this.swingHighs.splice(i, 1);
        }
      }
    }

    if (this.swingLows.length > 0) {
      for (let i = this.swingLows.length - 1; i >= 0; i--) {
        const l = this.swingLows[i];
        if (barIndex - l.x1 < expiryBars) {
          if (bar.low <= l.level) {
            l.pivotRef.mitigated = true;
            l.pivotRef.mitigatedAt = bar.time;
            l.pivotRef.mitigatedBarIndex = barIndex;
            this.swingLows.splice(i, 1);
            this.lastWickedLowLevel = l.level;
            this.lastWickedLowBar = barIndex;
          }
        } else {
          l.pivotRef.expired = true;
          this.swingLows.splice(i, 1);
        }
      }
    }

    while (this.swingHighs.length > 100) this.swingHighs.pop();
    while (this.swingLows.length > 100) this.swingLows.pop();

    const barsSinceHigh =
      this.lastWickedHighBar !== null ? barIndex - this.lastWickedHighBar : Number.POSITIVE_INFINITY;
    const barsSinceLow =
      this.lastWickedLowBar !== null ? barIndex - this.lastWickedLowBar : Number.POSITIVE_INFINITY;

    // 3. Inversion / Delivery Candle Detection
    if (barIndex >= 1) {
      const prev = this.bars[barIndex - 1];
      if (prev.close < prev.open && bar.close > bar.open) {
        this.bearPotential.unshift({ open: bar.open, barIndex });
      }
      if (prev.close > prev.open && bar.close < bar.open) {
        this.bullPotential.unshift({ open: bar.open, barIndex });
      }
    }

    // 4. Bearish & Bullish CISD Noise Filter Evaluation
    let cisd: 0 | 1 | 2 = 0;
    let originLvl = 0;
    let originIdx = 0;
    let noiseRatio = 0;

    while (this.bearPotential.length > 0) {
      const first = this.bearPotential[0];
      if (bar.close < first.open) {
        let highest = 0;
        for (let i = 0; i <= barIndex - first.barIndex; i++) {
          const c = this.bars[barIndex - i].close;
          if (c > highest) highest = c;
        }

        let init = barIndex - first.barIndex + 1;
        let top = 0;
        while (init <= barIndex) {
          const histBar = this.bars[barIndex - init];
          if (histBar.close < histBar.open) {
            top = histBar.open;
            init += 1;
          } else {
            break;
          }
        }

        const denom = top - first.open;
        const ratio = denom !== 0 ? (highest - first.open) / denom : 0;

        if (denom !== 0 && ratio > tolerance) {
          originLvl = first.open;
          originIdx = first.barIndex;
          noiseRatio = ratio;
          this.bearPotential = [];
          cisd = 1;
          break;
        } else {
          this.bearPotential.shift();
        }
      } else {
        break;
      }
    }

    while (this.bullPotential.length > 0) {
      const first = this.bullPotential[0];
      if (bar.close > first.open) {
        let lowest = bar.close;
        for (let i = 0; i <= barIndex - first.barIndex; i++) {
          const c = this.bars[barIndex - i].close;
          if (c < lowest) lowest = c;
        }

        let init = barIndex - first.barIndex + 1;
        let bottom = 0;
        while (init <= barIndex) {
          const histBar = this.bars[barIndex - init];
          if (histBar.close > histBar.open) {
            bottom = histBar.open;
            init += 1;
          } else {
            break;
          }
        }

        const denom = first.open - bottom;
        const ratio = denom !== 0 ? (first.open - lowest) / denom : 0;

        if (denom !== 0 && ratio > tolerance) {
          originLvl = first.open;
          originIdx = first.barIndex;
          noiseRatio = ratio;
          this.bullPotential = [];
          cisd = 2;
          break;
        } else {
          this.bullPotential.shift();
        }
      } else {
        break;
      }
    }

    let emittedSignal: CisdSignal | null = null;

    if (cisd === 1) {
      this.trend = -1;
      const strongSweep =
        barsSinceHigh <= liquidityLookback &&
        this.lastWickedHighLevel !== null &&
        bar.close < this.lastWickedHighLevel;

      emittedSignal = {
        id: `cisd_bear_${++this.uidCounter}`,
        barIndex,
        time: bar.time,
        direction: 'bearish',
        originLevel: originLvl,
        originBarIndex: originIdx,
        noiseRatio: Number(noiseRatio.toFixed(3)),
        toleranceUsed: tolerance,
        strongSweep,
        wickedSwingLevel: this.lastWickedHighLevel,
        barsSinceSwing: Number.isFinite(barsSinceHigh) ? barsSinceHigh : null,
        closePrice: bar.close,
      };
      this.cisdSignals.push(emittedSignal);
    } else if (cisd === 2) {
      this.trend = 1;
      const strongSweep =
        barsSinceLow <= liquidityLookback &&
        this.lastWickedLowLevel !== null &&
        bar.close > this.lastWickedLowLevel;

      emittedSignal = {
        id: `cisd_bull_${++this.uidCounter}`,
        barIndex,
        time: bar.time,
        direction: 'bullish',
        originLevel: originLvl,
        originBarIndex: originIdx,
        noiseRatio: Number(noiseRatio.toFixed(3)),
        toleranceUsed: tolerance,
        strongSweep,
        wickedSwingLevel: this.lastWickedLowLevel,
        barsSinceSwing: Number.isFinite(barsSinceLow) ? barsSinceLow : null,
        closePrice: bar.close,
      };
      this.cisdSignals.push(emittedSignal);
    }

    this.candleTrends.push(this.trend);
    return emittedSignal;
  }

  public getCurrentTrend(): number {
    return this.trend;
  }

  public getCandleTrends(): number[] {
    return this.candleTrends;
  }

  public getSwingPivots(): SwingPivot[] {
    return this.allPivots;
  }

  public getCisdSignals(): CisdSignal[] {
    return this.cisdSignals;
  }
}
