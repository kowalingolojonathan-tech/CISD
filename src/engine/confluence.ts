import { CisdEngine } from './cisd.ts';
import { computeSessionCountdown, getNyDateTime, KillzonesEngine } from './killzones.ts';
import { dispatchAlertWebhook } from './telegram.ts';
import type {
  Candle,
  CisdSignal,
  ConfluenceAlert,
  EngineConfig,
  EngineSnapshot,
  KillzoneSweepEvent,
} from './types.ts';

function maskSecret(val: string): string {
  const trimmed = val.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 8) return '••••••••';
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`;
}

export class TradingConfluenceEngine {
  private config: EngineConfig;
  private kzEngine: KillzonesEngine;
  private cisdEngine: CisdEngine;

  private confirmedBars: Candle[] = [];
  private liveBar: Candle | null = null;
  private confluenceAlerts: ConfluenceAlert[] = [];

  private lastKzHighSweep: KillzoneSweepEvent | null = null;
  private lastKzLowSweep: KillzoneSweepEvent | null = null;
  private consumedSweepIds = new Set<string>();

  private feedConnected = false;
  private lastTickAt: number | null = null;
  private lastError: string | null = null;
  private listeners = new Set<(snapshot: EngineSnapshot) => void>();

  constructor(initialConfig: EngineConfig) {
    this.config = { ...initialConfig };
    this.kzEngine = new KillzonesEngine(this.config.tzMode);
    this.cisdEngine = new CisdEngine({
      tolerance: this.config.tolerance,
      swingPeriod: this.config.swingPeriod,
      expiryBars: this.config.expiryBars,
      liquidityLookback: this.config.liquidityLookback,
    });
  }

  public subscribe(cb: (snapshot: EngineSnapshot) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private emit() {
    const snap = this.getSnapshot();
    for (const cb of this.listeners) {
      cb(snap);
    }
  }

  public getConfig(): EngineConfig {
    return { ...this.config };
  }

  public setFeedStatus(connected: boolean, lastTickAt: number | null, lastError: string | null) {
    this.feedConnected = connected;
    if (lastTickAt !== null) this.lastTickAt = lastTickAt;
    this.lastError = lastError;
    this.emit();
  }

  /**
   * Loads a full historical sequence of confirmed M3 candles (and optional current unconfirmed bar).
   * Historical confluences are recorded without firing live Telegram webhooks.
   */
  public loadHistory(bars: Candle[], liveBar: Candle | null = null) {
    this.kzEngine.reset(this.config.tzMode);
    this.cisdEngine.reset({
      tolerance: this.config.tolerance,
      swingPeriod: this.config.swingPeriod,
      expiryBars: this.config.expiryBars,
      liquidityLookback: this.config.liquidityLookback,
    });
    this.confirmedBars = [];
    this.liveBar = liveBar;
    this.confluenceAlerts = [];
    this.lastKzHighSweep = null;
    this.lastKzLowSweep = null;
    this.consumedSweepIds.clear();

    for (const bar of bars) {
      this.processConfirmedBarInternal(bar, false);
    }

    if (liveBar) {
      this.lastTickAt = Date.now();
    } else if (bars.length > 0) {
      this.lastTickAt = Date.now();
    }

    this.emit();
  }

  /**
   * Appends or updates the live M3 bar. When a new bar timestamp arrives, the previous
   * live bar is closed/confirmed and evaluated through CISD + Killzone confluence with live webhook dispatch.
   */
  public async ingestLiveBar(bar: Candle, isConfirmedClose: boolean) {
    const lastConfirmed = this.confirmedBars[this.confirmedBars.length - 1];

    if (lastConfirmed && bar.time < lastConfirmed.time) {
      return;
    }

    if (lastConfirmed && bar.time === lastConfirmed.time) {
      // Already confirmed
      return;
    }

    if (isConfirmedClose) {
      if (this.liveBar && this.liveBar.time === bar.time) {
        this.liveBar = null;
      }
      await this.processConfirmedBarInternal(bar, true);
    } else {
      // If we rolled over into a new 3m bucket, confirm the previous liveBar first
      if (this.liveBar && bar.time > this.liveBar.time) {
        const closedPrev: Candle = { ...this.liveBar, confirmed: true };
        this.liveBar = bar;
        await this.processConfirmedBarInternal(closedPrev, true);
      } else {
        this.liveBar = bar;
      }
    }

    this.lastTickAt = Date.now();
    this.emit();
  }

  public async updateConfig(patch: Partial<EngineConfig>) {
    const needsRecompute =
      (patch.tzMode !== undefined && patch.tzMode !== this.config.tzMode) ||
      (patch.tolerance !== undefined && patch.tolerance !== this.config.tolerance) ||
      (patch.swingPeriod !== undefined && patch.swingPeriod !== this.config.swingPeriod) ||
      (patch.expiryBars !== undefined && patch.expiryBars !== this.config.expiryBars) ||
      (patch.liquidityLookback !== undefined && patch.liquidityLookback !== this.config.liquidityLookback) ||
      (patch.kzLookbackBars !== undefined && patch.kzLookbackBars !== this.config.kzLookbackBars);

    this.config = { ...this.config, ...patch };

    if (needsRecompute && this.confirmedBars.length > 0) {
      const existingBars = [...this.confirmedBars];
      const existingLive = this.liveBar ? { ...this.liveBar } : null;
      this.loadHistory(existingBars, existingLive);
    } else {
      this.emit();
    }
  }

  private async processConfirmedBarInternal(bar: Candle, dispatchLiveWebhook: boolean) {
    const barIndex = this.confirmedBars.length;
    this.confirmedBars.push({ ...bar, confirmed: true });

    // 1. Killzones ICT processing (Session tracking + Unswept level sweeps)
    const newSweeps = this.kzEngine.processBar(bar, barIndex);
    for (const sw of newSweeps) {
      if (sw.isHigh) {
        this.lastKzHighSweep = sw;
      } else {
        this.lastKzLowSweep = sw;
      }
    }

    // 2. AlgoAlpha CISD M3 processing
    const cisdSignal = this.cisdEngine.processConfirmedBar(bar);

    // 3. Confluence Check: Killzone Level Sweep + Validated M3 CISD
    if (cisdSignal) {
      const confluence = this.evaluateConfluence(bar, barIndex, cisdSignal);
      if (confluence) {
        this.confluenceAlerts.unshift(confluence);
        if (this.confluenceAlerts.length > 100) {
          this.confluenceAlerts.length = 100;
        }

        if (dispatchLiveWebhook && this.config.alertsEnabled) {
          confluence.webhookStatus = 'pending';
          this.emit();
          const res = await dispatchAlertWebhook(confluence, {
            telegramBotToken: this.config.telegramBotToken,
            telegramChatId: this.config.telegramChatId,
            customWebhookUrl: this.config.customWebhookUrl,
          });
          confluence.webhookStatus = res.status;
          confluence.webhookDetail = res.detail;
          this.emit();
        }
      }
    }
  }

  private evaluateConfluence(bar: Candle, barIndex: number, cisd: CisdSignal): ConfluenceAlert | null {
    const lookback = this.config.kzLookbackBars;
    const ny = getNyDateTime(bar.time, this.config.tzMode);

    if (cisd.direction === 'bearish' && this.lastKzHighSweep) {
      const barsBetween = barIndex - this.lastKzHighSweep.sweptBarIndex;
      if (
        barsBetween >= 0 &&
        barsBetween <= lookback &&
        !this.consumedSweepIds.has(this.lastKzHighSweep.id)
      ) {
        this.consumedSweepIds.add(this.lastKzHighSweep.id);
        return {
          id: `conf_${bar.time}_${barIndex}`,
          timestamp: bar.time,
          nyTimeStr: ny.formatted,
          symbol: this.config.symbol,
          direction: 'BEARISH',
          kzSweep: this.lastKzHighSweep,
          cisd,
          barsBetweenSweepAndCisd: barsBetween,
          closedInsideLevel: bar.close < this.lastKzHighSweep.level,
          hasInternalSwingSweep: cisd.strongSweep,
          webhookStatus: 'skipped',
          webhookDetail: 'Historique initial',
        };
      }
    }

    if (cisd.direction === 'bullish' && this.lastKzLowSweep) {
      const barsBetween = barIndex - this.lastKzLowSweep.sweptBarIndex;
      if (
        barsBetween >= 0 &&
        barsBetween <= lookback &&
        !this.consumedSweepIds.has(this.lastKzLowSweep.id)
      ) {
        this.consumedSweepIds.add(this.lastKzLowSweep.id);
        return {
          id: `conf_${bar.time}_${barIndex}`,
          timestamp: bar.time,
          nyTimeStr: ny.formatted,
          symbol: this.config.symbol,
          direction: 'BULLISH',
          kzSweep: this.lastKzLowSweep,
          cisd,
          barsBetweenSweepAndCisd: barsBetween,
          closedInsideLevel: bar.close > this.lastKzLowSweep.level,
          hasInternalSwingSweep: cisd.strongSweep,
          webhookStatus: 'skipped',
          webhookDetail: 'Historique initial',
        };
      }
    }

    return null;
  }

  public async sendTestWebhook(): Promise<{ ok: boolean; detail: string; alert: ConfluenceAlert }> {
    const latestBar = this.liveBar ?? this.confirmedBars[this.confirmedBars.length - 1];
    const now = latestBar ? latestBar.time : Date.now();
    const price = latestBar ? latestBar.close : 3741.0;
    const ny = getNyDateTime(now, this.config.tzMode);

    const sampleAlert: ConfluenceAlert = this.confluenceAlerts[0]
      ? {
          ...this.confluenceAlerts[0],
          id: `test_${Date.now()}`,
          nyTimeStr: ny.formatted,
        }
      : {
          id: `test_${Date.now()}`,
          timestamp: now,
          nyTimeStr: ny.formatted,
          symbol: this.config.symbol,
          direction: 'BEARISH',
          kzSweep: {
            id: 'test_swp',
            levelId: 'test_lvl',
            sessionId: 'london',
            sessionName: 'London',
            shortName: 'L',
            isHigh: true,
            level: Number((price + 1.8).toFixed(2)),
            sweptAt: now - 180000,
            sweptBarIndex: Math.max(0, this.confirmedBars.length - 2),
            sweepPrice: Number((price + 2.4).toFixed(2)),
          },
          cisd: {
            id: 'test_cisd',
            barIndex: Math.max(0, this.confirmedBars.length - 1),
            time: now,
            direction: 'bearish',
            originLevel: Number((price + 0.9).toFixed(2)),
            originBarIndex: Math.max(0, this.confirmedBars.length - 3),
            noiseRatio: 0.84,
            toleranceUsed: this.config.tolerance,
            strongSweep: true,
            wickedSwingLevel: Number((price + 1.5).toFixed(2)),
            barsSinceSwing: 2,
            closePrice: price,
          },
          barsBetweenSweepAndCisd: 1,
          closedInsideLevel: true,
          hasInternalSwingSweep: true,
          webhookStatus: 'pending',
        };

    const res = await dispatchAlertWebhook(sampleAlert, {
      telegramBotToken: this.config.telegramBotToken,
      telegramChatId: this.config.telegramChatId,
      customWebhookUrl: this.config.customWebhookUrl,
    });

    return {
      ok: res.sent,
      detail: res.detail,
      alert: { ...sampleAlert, webhookStatus: res.status, webhookDetail: res.detail },
    };
  }

  public getSnapshot(): EngineSnapshot {
    const allCandles = this.liveBar
      ? [...this.confirmedBars, this.liveBar]
      : [...this.confirmedBars];

    const currentTrend = this.cisdEngine.getCurrentTrend();
    const baseTrends = this.cisdEngine.getCandleTrends();
    const candleTrends = this.liveBar ? [...baseTrends, currentTrend] : baseTrends;

    const latestTime = allCandles.length > 0 ? allCandles[allCandles.length - 1].time : Date.now();
    const latestClose = allCandles.length > 0 ? allCandles[allCandles.length - 1].close : 0;

    return {
      config: {
        symbol: this.config.symbol,
        marketSource: this.config.marketSource,
        tzMode: this.config.tzMode,
        tolerance: this.config.tolerance,
        swingPeriod: this.config.swingPeriod,
        expiryBars: this.config.expiryBars,
        liquidityLookback: this.config.liquidityLookback,
        kzLookbackBars: this.config.kzLookbackBars,
        telegramChatId: this.config.telegramChatId,
        customWebhookUrl: this.config.customWebhookUrl,
        alertsEnabled: this.config.alertsEnabled,
        hasTelegramToken: this.config.telegramBotToken.trim().length > 0,
        telegramTokenMasked: maskSecret(this.config.telegramBotToken),
        hasTwelveDataKey: this.config.twelveDataApiKey.trim().length > 0,
      },
      candles: allCandles,
      candleTrends,
      sessions: this.kzEngine.getBoxes(),
      unsweptLevels: this.kzEngine.getUnsweptLevels(),
      sweepEvents: this.kzEngine.getSweepEvents(),
      countdown: computeSessionCountdown(Date.now(), this.config.tzMode),
      daySummaries: this.kzEngine.getDaySummaries(latestClose),
      swingPivots: this.cisdEngine.getSwingPivots(),
      cisdSignals: this.cisdEngine.getCisdSignals(),
      confluenceAlerts: this.confluenceAlerts,
      feedStatus: {
        source: this.config.marketSource,
        connected: this.feedConnected,
        lastTickAt: this.lastTickAt,
        lastError: this.lastError,
        barCount: allCandles.length,
      },
    };
  }
}
