import { CisdEngine } from './cisd.ts';
import { computeSessionCountdown, getNyDateTime, KillzonesEngine } from './killzones.ts';
import { dispatchAlertWebhook } from './telegram.ts';
import {
  getPriceDecimals,
  type AlertAckStatus,
  type Candle,
  type CisdSignal,
  type ConfluenceAlert,
  type EngineConfig,
  type EngineSnapshot,
  type HtfBiasDirection,
  type HtfBiasState,
  type KillzoneSweepEvent,
  type ProbabilityTier,
} from './types.ts';

const LIVE_ALERT_FRESHNESS_MS = 6 * 60 * 1000; // Signal must be <= 6 min old to qualify as "en cours"

interface PersistedAckState {
  ackStatus: AlertAckStatus;
  acknowledgedAt: number | null;
  acknowledgedBy: 'ui' | 'telegram' | null;
  reminderCount: number;
  lastReminderAt: number | null;
  nextReminderAt: number | null;
  webhookStatus: 'pending' | 'sent' | 'skipped' | 'failed';
  webhookDetail?: string;
}

function maskSecret(val: string): string {
  const trimmed = val.trim();
  if (!trimmed) return '';
  if (trimmed.length <= 8) return '••••••••';
  return `${trimmed.slice(0, 4)}••••${trimmed.slice(-4)}`;
}

function trendToBias(t: number): HtfBiasDirection {
  if (t > 0) return 'BULLISH';
  if (t < 0) return 'BEARISH';
  return 'NEUTRAL';
}

export class TradingConfluenceEngine {
  private config: EngineConfig;
  private kzEngine: KillzonesEngine;
  private cisdEngine: CisdEngine;

  // Higher-timeframe (Daily & H4) CISD bias tracking
  private d1Bars: Candle[] = [];
  private d1Trends: number[] = [];
  private d1LastSignal: CisdSignal | null = null;
  private h4Bars: Candle[] = [];
  private h4Trends: number[] = [];
  private h4LastSignal: CisdSignal | null = null;

  private confirmedBars: Candle[] = [];
  private liveBar: Candle | null = null;
  private confluenceAlerts: ConfluenceAlert[] = [];

  private lastKzHighSweep: KillzoneSweepEvent | null = null;
  private lastKzLowSweep: KillzoneSweepEvent | null = null;
  private consumedSweepKeys = new Set<string>();
  private persistedAlertStates = new Map<string, PersistedAckState>();
  private isReminderTickRunning = false;

  private feedConnected = false;
  private lastTickAt: number | null = null;
  private lastError: string | null = null;
  private listeners = new Set<(snapshot: EngineSnapshot) => void>();
  private alertNotifier: ((alert: ConfluenceAlert, reminderNumber: number) => void) | null = null;

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

  /**
   * Registers a fire-and-forget hook called the instant a live alert (or a reminder) is due,
   * BEFORE the Telegram round-trip is awaited. Used for native push (FCM).
   */
  public setAlertNotifier(fn: ((alert: ConfluenceAlert, reminderNumber: number) => void) | null) {
    this.alertNotifier = fn;
  }

  private notify(alert: ConfluenceAlert, reminderNumber: number) {
    try {
      this.alertNotifier?.(alert, reminderNumber);
    } catch {
      // A notifier failure must never break the engine
    }
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

  public getPendingAlertCount(): number {
    return this.confluenceAlerts.filter((a) => a.ackStatus === 'pending').length;
  }

  /**
   * Acknowledge one alert (by id, dedupeKey, or timestamp string) so repeat reminders stop immediately.
   */
  public acknowledgeAlert(
    identifier: string,
    source: 'ui' | 'telegram' = 'ui'
  ): ConfluenceAlert | null {
    const now = Date.now();
    let matched: ConfluenceAlert | null = null;

    for (const alert of this.confluenceAlerts) {
      if (
        alert.id === identifier ||
        alert.dedupeKey === identifier ||
        String(alert.timestamp) === identifier
      ) {
        if (alert.ackStatus === 'pending') {
          alert.ackStatus = 'acknowledged';
          alert.acknowledgedAt = now;
          alert.acknowledgedBy = source;
          alert.nextReminderAt = null;
          alert.webhookDetail =
            source === 'telegram' ? 'Valide via Telegram (Vu)' : "Valide dans l'app (Vu)";
          this.saveAckState(alert);
        }
        matched = alert;
      }
    }

    if (matched) {
      this.emit();
    }
    return matched;
  }

  /**
   * Acknowledge all currently pending live alerts.
   */
  public acknowledgeAllPending(source: 'ui' | 'telegram' = 'ui'): number {
    const now = Date.now();
    let count = 0;
    for (const alert of this.confluenceAlerts) {
      if (alert.ackStatus === 'pending') {
        alert.ackStatus = 'acknowledged';
        alert.acknowledgedAt = now;
        alert.acknowledgedBy = source;
        alert.nextReminderAt = null;
        alert.webhookDetail =
          source === 'telegram' ? 'Valide via Telegram (Vu)' : "Valide dans l'app (Vu)";
        this.saveAckState(alert);
        count++;
      }
    }
    if (count > 0) {
      this.emit();
    }
    return count;
  }

  /**
   * Called periodically (every ~5s) to re-send Telegram reminders for unacknowledged live alerts
   * while they are still active ("en cours"). Stops when validated or expired.
   */
  public async processPendingReminders() {
    if (this.isReminderTickRunning) return;
    this.isReminderTickRunning = true;
    try {
      const now = Date.now();
      const maxWindowMs = Math.max(5, this.config.liveSetupMaxMinutes) * 60 * 1000;
      const intervalMs = Math.max(10, this.config.repeatAlertIntervalSec) * 1000;
      const activeKzNow = this.kzEngine.getActiveSessionAt(now);
      let changed = false;

      for (const alert of this.confluenceAlerts) {
        if (alert.ackStatus !== 'pending') continue;

        const elapsed = now - alert.timestamp;
        if (elapsed > maxWindowMs || (this.config.requireActiveKillzone && !activeKzNow)) {
          alert.ackStatus = 'expired';
          alert.nextReminderAt = null;
          alert.webhookDetail = !activeKzNow
            ? 'Killzone terminee — rappel arrete'
            : 'Fenetre en cours expiree';
          this.saveAckState(alert);
          changed = true;
          continue;
        }

        if (!this.config.alertsEnabled) {
          continue;
        }

        const lastSent = alert.lastReminderAt ?? alert.timestamp;
        if (now - lastSent >= intervalMs) {
          alert.reminderCount += 1;
          alert.lastReminderAt = now;
          alert.nextReminderAt = now + intervalMs;
          this.saveAckState(alert);
          this.emit();
          this.notify(alert, alert.reminderCount);

          const res = await dispatchAlertWebhook(alert, {
            telegramBotToken: this.config.telegramBotToken,
            telegramChatId: this.config.telegramChatId,
            customWebhookUrl: this.config.customWebhookUrl,
            reminderNumber: alert.reminderCount,
            includeAckButton: true,
          });
          alert.webhookStatus = res.status;
          alert.webhookDetail = res.detail;
          this.saveAckState(alert);
          changed = true;
        }
      }

      if (changed) {
        this.emit();
      }
    } finally {
      this.isReminderTickRunning = false;
    }
  }

  private saveAckState(alert: ConfluenceAlert) {
    this.persistedAlertStates.set(alert.dedupeKey, {
      ackStatus: alert.ackStatus,
      acknowledgedAt: alert.acknowledgedAt,
      acknowledgedBy: alert.acknowledgedBy ?? null,
      reminderCount: alert.reminderCount,
      lastReminderAt: alert.lastReminderAt,
      nextReminderAt: alert.nextReminderAt,
      webhookStatus: alert.webhookStatus,
      webhookDetail: alert.webhookDetail,
    });
  }

  /**
   * Computes real Daily (D1) and 4-Hour (H4) CISD bias timeline.
   */
  public loadHtfHistory(d1Bars: Candle[], h4Bars: Candle[], shouldEmit = true) {
    this.d1Bars = [...d1Bars];
    this.h4Bars = [...h4Bars];

    const d1Cisd = new CisdEngine({
      tolerance: this.config.tolerance,
      swingPeriod: 5,
      expiryBars: 60,
      liquidityLookback: 10,
    });
    for (const b of this.d1Bars) {
      d1Cisd.processConfirmedBar(b);
    }
    this.d1Trends = [...d1Cisd.getCandleTrends()];
    const d1Sigs = d1Cisd.getCisdSignals();
    this.d1LastSignal = d1Sigs.length > 0 ? d1Sigs[d1Sigs.length - 1] : null;

    const h4Cisd = new CisdEngine({
      tolerance: this.config.tolerance,
      swingPeriod: 8,
      expiryBars: 80,
      liquidityLookback: 10,
    });
    for (const b of this.h4Bars) {
      h4Cisd.processConfirmedBar(b);
    }
    this.h4Trends = [...h4Cisd.getCandleTrends()];
    const h4Sigs = h4Cisd.getCisdSignals();
    this.h4LastSignal = h4Sigs.length > 0 ? h4Sigs[h4Sigs.length - 1] : null;

    if (shouldEmit) {
      this.emit();
    }
  }

  private lookupTrendAt(bars: Candle[], trends: number[], timestampMs: number): HtfBiasDirection {
    if (bars.length === 0 || trends.length === 0) return 'NEUTRAL';
    let lastTrend = 0;
    for (let i = 0; i < bars.length; i++) {
      if (bars[i].time <= timestampMs) {
        lastTrend = trends[i] ?? 0;
      } else {
        break;
      }
    }
    return trendToBias(lastTrend);
  }

  private getCurrentHtfBiasState(): HtfBiasState {
    const dailyAuto =
      this.d1Trends.length > 0 ? trendToBias(this.d1Trends[this.d1Trends.length - 1]) : 'NEUTRAL';
    const h4Auto =
      this.h4Trends.length > 0 ? trendToBias(this.h4Trends[this.h4Trends.length - 1]) : 'NEUTRAL';

    const daily: HtfBiasDirection =
      this.config.dailyBiasMode === 'AUTO' ? dailyAuto : this.config.dailyBiasMode;
    const h4: HtfBiasDirection =
      this.config.h4BiasMode === 'AUTO' ? h4Auto : this.config.h4BiasMode;

    const alignedDirection = daily !== 'NEUTRAL' && daily === h4 ? daily : null;

    return {
      daily,
      h4,
      dailyMode: this.config.dailyBiasMode,
      h4Mode: this.config.h4BiasMode,
      dailyOriginLevel: this.d1LastSignal?.originLevel ?? null,
      h4OriginLevel: this.h4LastSignal?.originLevel ?? null,
      dailyLastTime: this.d1LastSignal?.time ?? null,
      h4LastTime: this.h4LastSignal?.time ?? null,
      alignedDirection,
    };
  }

  private computeProbabilityAt(
    timestampMs: number,
    direction: 'BEARISH' | 'BULLISH'
  ): { dailyBias: HtfBiasDirection; h4Bias: HtfBiasDirection; probability: ProbabilityTier } {
    const dailyBias =
      this.config.dailyBiasMode === 'AUTO'
        ? this.lookupTrendAt(this.d1Bars, this.d1Trends, timestampMs)
        : this.config.dailyBiasMode;
    const h4Bias =
      this.config.h4BiasMode === 'AUTO'
        ? this.lookupTrendAt(this.h4Bars, this.h4Trends, timestampMs)
        : this.config.h4BiasMode;

    let probability: ProbabilityTier = 'COUNTER_TREND';
    if (dailyBias === direction && h4Bias === direction) {
      probability = 'HIGH';
    } else if (dailyBias === direction || h4Bias === direction) {
      probability = 'MEDIUM';
    }

    return { dailyBias, h4Bias, probability };
  }

  /**
   * Loads historical confirmed M3 candles. Historical confluences populate the table
   * without triggering live Telegram webhooks.
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
    this.consumedSweepKeys.clear();

    for (const bar of bars) {
      this.processConfirmedBarInternal(bar, false);
    }

    if (liveBar || bars.length > 0) {
      this.lastTickAt = Date.now();
    }

    this.emit();
  }

  /**
   * Appends or updates the live M3 bar.
   */
  public async ingestLiveBar(bar: Candle, isConfirmedClose: boolean) {
    const lastConfirmed = this.confirmedBars[this.confirmedBars.length - 1];

    if (lastConfirmed && bar.time < lastConfirmed.time) {
      return;
    }
    if (lastConfirmed && bar.time === lastConfirmed.time) {
      return;
    }

    if (isConfirmedClose) {
      if (this.liveBar && this.liveBar.time === bar.time) {
        this.liveBar = null;
      }
      await this.processConfirmedBarInternal(bar, true);
    } else {
      if (this.liveBar && bar.time > this.liveBar.time) {
        const closedPrev: Candle = { ...this.liveBar, confirmed: true };
        this.liveBar = bar;
        await this.processConfirmedBarInternal(closedPrev, true);
      } else {
        this.liveBar = bar;
      }

      if (this.config.triggerOnIntrabar && this.liveBar) {
        await this.evaluateLiveIntrabar(this.liveBar);
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
      (patch.kzLookbackBars !== undefined && patch.kzLookbackBars !== this.config.kzLookbackBars) ||
      (patch.requireActiveKillzone !== undefined &&
        patch.requireActiveKillzone !== this.config.requireActiveKillzone) ||
      (patch.dailyBiasMode !== undefined && patch.dailyBiasMode !== this.config.dailyBiasMode) ||
      (patch.h4BiasMode !== undefined && patch.h4BiasMode !== this.config.h4BiasMode);

    this.config = { ...this.config, ...patch };

    if (needsRecompute && (this.d1Bars.length > 0 || this.h4Bars.length > 0)) {
      this.loadHtfHistory(this.d1Bars, this.h4Bars, false);
    }

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

    const newSweeps = this.kzEngine.processBar(bar, barIndex);
    for (const sw of newSweeps) {
      if (sw.isHigh) {
        this.lastKzHighSweep = sw;
      } else {
        this.lastKzLowSweep = sw;
      }
    }

    const cisdSignal = this.cisdEngine.processConfirmedBar(bar);

    if (cisdSignal) {
      const confluence = this.evaluateConfluence(
        bar,
        barIndex,
        cisdSignal,
        this.lastKzHighSweep,
        this.lastKzLowSweep,
        false
      );
      if (confluence) {
        await this.recordAndDispatchAlert(confluence, dispatchLiveWebhook);
      }
    }
  }

  private async evaluateLiveIntrabar(liveBar: Candle) {
    const liveBarIndex = this.confirmedBars.length;
    const liveSweeps = this.kzEngine.previewLiveSweeps(liveBar, liveBarIndex);

    let effectiveHighSweep = this.lastKzHighSweep;
    let effectiveLowSweep = this.lastKzLowSweep;

    for (const sw of liveSweeps) {
      if (sw.isHigh) {
        effectiveHighSweep = sw;
      } else {
        effectiveLowSweep = sw;
      }
    }

    const liveCisd = this.cisdEngine.previewLiveBar(liveBar);
    if (!liveCisd) return;

    const confluence = this.evaluateConfluence(
      liveBar,
      liveBarIndex,
      liveCisd,
      effectiveHighSweep,
      effectiveLowSweep,
      true
    );

    if (confluence) {
      await this.recordAndDispatchAlert(confluence, true);
    }
  }

  private async recordAndDispatchAlert(confluence: ConfluenceAlert, dispatchLiveWebhook: boolean) {
    const saved = this.persistedAlertStates.get(confluence.dedupeKey);
    if (saved) {
      confluence.ackStatus = saved.ackStatus;
      confluence.acknowledgedAt = saved.acknowledgedAt;
      confluence.acknowledgedBy = saved.acknowledgedBy;
      confluence.reminderCount = saved.reminderCount;
      confluence.lastReminderAt = saved.lastReminderAt;
      confluence.nextReminderAt = saved.nextReminderAt;
      confluence.webhookStatus = saved.webhookStatus;
      confluence.webhookDetail = saved.webhookDetail;
    }

    this.confluenceAlerts.unshift(confluence);
    if (this.confluenceAlerts.length > 100) {
      this.confluenceAlerts.length = 100;
    }

    if (saved) {
      return;
    }

    const now = Date.now();
    const ageMs = now - confluence.timestamp;
    const isFreshLiveSetup = ageMs <= LIVE_ALERT_FRESHNESS_MS;
    const activeKzNow = this.kzEngine.getActiveSessionAt(now);

    if (!dispatchLiveWebhook || !isFreshLiveSetup) {
      confluence.ackStatus = 'historical';
      confluence.webhookStatus = 'skipped';
      confluence.webhookDetail =
        dispatchLiveWebhook && !isFreshLiveSetup
          ? 'Signal passe (> 6 min) — ignore'
          : 'Historique passe';
      return;
    }

    if (this.config.requireActiveKillzone && !activeKzNow) {
      confluence.ackStatus = 'historical';
      confluence.webhookStatus = 'skipped';
      confluence.webhookDetail = 'Killzone fermee actuellement';
      return;
    }

    if (!this.config.alertsEnabled) {
      confluence.ackStatus = 'historical';
      confluence.webhookStatus = 'skipped';
      confluence.webhookDetail = 'Alertes desactivees';
      return;
    }

    if (this.config.highProbabilityOnly && confluence.probability !== 'HIGH') {
      confluence.ackStatus = 'historical';
      confluence.webhookStatus = 'skipped';
      confluence.webhookDetail = 'Filtre Haute Probabilite D1+H4 actif';
      this.emit();
      return;
    }

    // Fresh live ("en cours") alert -> enter pending validation state and dispatch immediately!
    const intervalMs = Math.max(10, this.config.repeatAlertIntervalSec) * 1000;
    confluence.ackStatus = 'pending';
    confluence.reminderCount = 1;
    confluence.lastReminderAt = now;
    confluence.nextReminderAt = now + intervalMs;
    confluence.webhookStatus = 'pending';
    this.saveAckState(confluence);
    this.emit();
    this.notify(confluence, 1);

    const res = await dispatchAlertWebhook(confluence, {
      telegramBotToken: this.config.telegramBotToken,
      telegramChatId: this.config.telegramChatId,
      customWebhookUrl: this.config.customWebhookUrl,
      reminderNumber: 1,
      includeAckButton: true,
    });
    confluence.webhookStatus = res.status;
    confluence.webhookDetail = res.detail;
    this.saveAckState(confluence);
    this.emit();
  }

  private evaluateConfluence(
    bar: Candle,
    barIndex: number,
    cisd: CisdSignal,
    highSweep: KillzoneSweepEvent | null,
    lowSweep: KillzoneSweepEvent | null,
    isIntrabarSignal: boolean
  ): ConfluenceAlert | null {
    const activeSession = this.kzEngine.getActiveSessionAt(bar.time);
    if (this.config.requireActiveKillzone && !activeSession) {
      return null;
    }

    const lookback = this.config.kzLookbackBars;
    const ny = getNyDateTime(bar.time, this.config.tzMode);

    if (cisd.direction === 'bearish' && highSweep) {
      const barsBetween = barIndex - highSweep.sweptBarIndex;
      const dedupeKey = `${highSweep.levelId}_BEARISH`;
      if (
        barsBetween >= 0 &&
        barsBetween <= lookback &&
        !this.consumedSweepKeys.has(dedupeKey)
      ) {
        this.consumedSweepKeys.add(dedupeKey);
        const closedInsideLevel = bar.close < highSweep.level;
        const { dailyBias, h4Bias, probability } = this.computeProbabilityAt(bar.time, 'BEARISH');
        return {
          id: `conf_${bar.time}_${barIndex}_${isIntrabarSignal ? 'live' : 'cls'}`,
          dedupeKey,
          timestamp: bar.time,
          nyTimeStr: ny.formatted,
          symbol: this.config.symbol,
          direction: 'BEARISH',
          activeKillzoneName: activeSession ? activeSession.name : null,
          dailyBias,
          h4Bias,
          probability,
          kzSweep: highSweep,
          cisd,
          barsBetweenSweepAndCisd: barsBetween,
          closedInsideLevel,
          isPreReentry: !closedInsideLevel,
          isIntrabarSignal,
          hasInternalSwingSweep: cisd.strongSweep,
          webhookStatus: 'skipped',
          webhookDetail: isIntrabarSignal ? 'Temps reel' : 'Historique passe',
          ackStatus: 'historical',
          acknowledgedAt: null,
          acknowledgedBy: null,
          reminderCount: 0,
          lastReminderAt: null,
          nextReminderAt: null,
        };
      }
    }

    if (cisd.direction === 'bullish' && lowSweep) {
      const barsBetween = barIndex - lowSweep.sweptBarIndex;
      const dedupeKey = `${lowSweep.levelId}_BULLISH`;
      if (
        barsBetween >= 0 &&
        barsBetween <= lookback &&
        !this.consumedSweepKeys.has(dedupeKey)
      ) {
        this.consumedSweepKeys.add(dedupeKey);
        const closedInsideLevel = bar.close > lowSweep.level;
        const { dailyBias, h4Bias, probability } = this.computeProbabilityAt(bar.time, 'BULLISH');
        return {
          id: `conf_${bar.time}_${barIndex}_${isIntrabarSignal ? 'live' : 'cls'}`,
          dedupeKey,
          timestamp: bar.time,
          nyTimeStr: ny.formatted,
          symbol: this.config.symbol,
          direction: 'BULLISH',
          activeKillzoneName: activeSession ? activeSession.name : null,
          dailyBias,
          h4Bias,
          probability,
          kzSweep: lowSweep,
          cisd,
          barsBetweenSweepAndCisd: barsBetween,
          closedInsideLevel,
          isPreReentry: !closedInsideLevel,
          isIntrabarSignal,
          hasInternalSwingSweep: cisd.strongSweep,
          webhookStatus: 'skipped',
          webhookDetail: isIntrabarSignal ? 'Temps reel' : 'Historique passe',
          ackStatus: 'historical',
          acknowledgedAt: null,
          acknowledgedBy: null,
          reminderCount: 0,
          lastReminderAt: null,
          nextReminderAt: null,
        };
      }
    }

    return null;
  }

  public async sendTestWebhook(): Promise<{ ok: boolean; detail: string; alert: ConfluenceAlert }> {
    const latestBar = this.liveBar ?? this.confirmedBars[this.confirmedBars.length - 1];
    const now = latestBar ? latestBar.time : Date.now();
    const isEurUsd = this.config.symbol === 'EUR/USD';
    const decimals = getPriceDecimals(this.config.symbol);
    const step = isEurUsd ? 0.0005 : 0.8;
    const price = latestBar ? latestBar.close : isEurUsd ? 1.097 : 3741.0;
    const ny = getNyDateTime(now, this.config.tzMode);
    const activeSession = this.kzEngine.getActiveSessionAt(now);
    const htf = this.getCurrentHtfBiasState();

    const sampleAlert: ConfluenceAlert = this.confluenceAlerts[0]
      ? {
          ...this.confluenceAlerts[0],
          id: `test_${Date.now()}`,
          nyTimeStr: ny.formatted,
        }
      : {
          id: `test_${Date.now()}`,
          dedupeKey: `test_${Date.now()}`,
          timestamp: now,
          nyTimeStr: ny.formatted,
          symbol: this.config.symbol,
          direction: htf.alignedDirection === 'BULLISH' ? 'BULLISH' : 'BEARISH',
          activeKillzoneName: activeSession?.name ?? 'NY PM',
          dailyBias: htf.daily,
          h4Bias: htf.h4,
          probability: htf.alignedDirection ? 'HIGH' : 'MEDIUM',
          kzSweep: {
            id: 'test_swp',
            levelId: 'test_lvl',
            sessionId: 'london',
            sessionName: 'London',
            shortName: 'L',
            isHigh: true,
            level: Number((price - step * 1.5).toFixed(decimals)),
            sweptAt: now - 180000,
            sweptBarIndex: Math.max(0, this.confirmedBars.length - 1),
            sweepPrice: Number((price + step).toFixed(decimals)),
          },
          cisd: {
            id: 'test_cisd',
            barIndex: Math.max(0, this.confirmedBars.length - 1),
            time: now,
            direction: htf.alignedDirection === 'BULLISH' ? 'bullish' : 'bearish',
            originLevel: Number((price + step * 0.5).toFixed(decimals)),
            originBarIndex: Math.max(0, this.confirmedBars.length - 2),
            noiseRatio: 0.84,
            toleranceUsed: this.config.tolerance,
            strongSweep: true,
            wickedSwingLevel: Number((price + step * 0.75).toFixed(decimals)),
            barsSinceSwing: 1,
            closePrice: price,
          },
          barsBetweenSweepAndCisd: 0,
          closedInsideLevel: false,
          isPreReentry: true,
          isIntrabarSignal: true,
          hasInternalSwingSweep: true,
          webhookStatus: 'pending',
          ackStatus: 'acknowledged',
          acknowledgedAt: now,
          acknowledgedBy: 'ui',
          reminderCount: 1,
          lastReminderAt: now,
          nextReminderAt: null,
        };

    const res = await dispatchAlertWebhook(sampleAlert, {
      telegramBotToken: this.config.telegramBotToken,
      telegramChatId: this.config.telegramChatId,
      customWebhookUrl: this.config.customWebhookUrl,
      reminderNumber: 1,
      includeAckButton: false,
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
        requireActiveKillzone: this.config.requireActiveKillzone,
        triggerOnIntrabar: this.config.triggerOnIntrabar,
        dailyBiasMode: this.config.dailyBiasMode,
        h4BiasMode: this.config.h4BiasMode,
        highProbabilityOnly: this.config.highProbabilityOnly,
        telegramChatId: this.config.telegramChatId,
        customWebhookUrl: this.config.customWebhookUrl,
        alertsEnabled: this.config.alertsEnabled,
        repeatAlertIntervalSec: this.config.repeatAlertIntervalSec,
        liveSetupMaxMinutes: this.config.liveSetupMaxMinutes,
        hasTelegramToken: this.config.telegramBotToken.trim().length > 0,
        telegramTokenMasked: maskSecret(this.config.telegramBotToken),
        hasTwelveDataKey: this.config.twelveDataApiKey.trim().length > 0,
      },
      htfBias: this.getCurrentHtfBiasState(),
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
