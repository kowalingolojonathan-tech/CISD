import { CisdEngine } from './cisd.ts';
import { ChochEngine } from './choch.ts';
import { computeSessionCountdown, getNyDateTime, KillzonesEngine, nyCalendarDayDistance } from './killzones.ts';
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
const MAX_ALERT_DELIVERIES = 10; // Initial message + up to 9 reminders until acknowledgement

interface PersistedAckState {
  ackStatus: AlertAckStatus;
  acknowledgedAt: number | null;
  acknowledgedBy: 'ui' | 'telegram' | null;
  reminderCount: number;
  lastReminderAt: number | null;
  nextReminderAt: number | null;
  webhookStatus: 'pending' | 'sent' | 'skipped' | 'failed';
  webhookDetail?: string;
  invalidatedAt?: number | null;
  retryUntil?: number | null;
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
  private chochM3Engine: ChochEngine;
  private chochM2Engine: ChochEngine;
  private confirmedM2Bars: Candle[] = [];
  private liveM2Bar: Candle | null = null;

  // Higher-timeframe (Daily & H4) CHoCH bias tracking
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

  private feedConnected = false;
  private lastTickAt: number | null = null;
  private lastError: string | null = null;
  private listeners = new Set<(snapshot: EngineSnapshot) => void>();
  private alertNotifier: ((alert: ConfluenceAlert, reminderNumber: number) => void) | null = null;

  constructor(initialConfig: EngineConfig) {
    this.config = { ...initialConfig };
    this.kzEngine = new KillzonesEngine(this.config.tzMode);
    this.chochM3Engine = new ChochEngine();
    this.chochM2Engine = new ChochEngine();
  }

  /** Registers a fire-and-forget hook for the single notification sent for each new live setup. */
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
   * Re-sends Telegram reminders for pending live alerts at the configured interval.
   * The initial delivery plus reminders are capped at 10; acknowledgement stops them immediately.
   */
  public async processPendingReminders() {
    const now = Date.now();
    const maxWindowMs = Math.max(5, this.config.liveSetupMaxMinutes) * 60 * 1000;
    const nowNyDay = getNyDateTime(now, this.config.tzMode).dayKey;
    let changed = false;

    for (const alert of this.confluenceAlerts) {
      if (alert.ackStatus !== 'pending') continue;
      const elapsed = now - alert.timestamp;
      const nyDayExpired = getNyDateTime(alert.timestamp, this.config.tzMode).dayKey !== nowNyDay;
      if (elapsed > maxWindowMs || nyDayExpired) {
        alert.ackStatus = 'expired';
        alert.nextReminderAt = null;
        alert.webhookDetail = nyDayExpired
          ? 'Fin de la journee de trading New York — alerte conservee dans historique'
          : 'Fenetre du setup expiree — alerte conservee dans historique';
        this.saveAckState(alert);
        changed = true;
        continue;
      }

      if (alert.reminderCount >= MAX_ALERT_DELIVERIES) {
        if (alert.nextReminderAt !== null) {
          alert.nextReminderAt = null;
          alert.webhookDetail = `Limite de ${MAX_ALERT_DELIVERIES} notifications atteinte — en attente de validation`;
          this.saveAckState(alert);
          changed = true;
        }
        continue;
      }

      if (alert.nextReminderAt === null || now < alert.nextReminderAt) continue;

      const reminderNumber = alert.reminderCount + 1;
      const intervalMs = Math.max(10, this.config.repeatAlertIntervalSec) * 1000;
      alert.reminderCount = reminderNumber;
      alert.lastReminderAt = now;
      alert.nextReminderAt = reminderNumber < MAX_ALERT_DELIVERIES ? now + intervalMs : null;
      alert.webhookStatus = 'pending';
      alert.webhookDetail = `Envoi du rappel #${reminderNumber}`;
      this.saveAckState(alert);
      this.emit();

      const result = await dispatchAlertWebhook(alert, {
        telegramBotToken: this.config.telegramBotToken,
        telegramChatId: this.config.telegramChatId,
        customWebhookUrl: this.config.customWebhookUrl,
        reminderNumber,
        includeAckButton: true,
      });
      alert.webhookStatus = result.status;
      alert.webhookDetail = result.detail;
      this.saveAckState(alert);
      this.emit();
    }

    if (changed) this.emit();
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
      invalidatedAt: alert.invalidatedAt ?? null,
      retryUntil: alert.retryUntil ?? null,
    });
  }

  /**
   * Computes real Daily (D1) and 4-Hour (H4) CHoCH bias timeline.
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
    this.chochM3Engine.reset();
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

  /** Loads real M2 candles built from 1-minute source data. Historical M2 setups never notify. */
  public loadM2History(bars: Candle[], liveBar: Candle | null = null) {
    this.chochM2Engine.reset();
    this.confirmedM2Bars = [];
    this.liveM2Bar = liveBar;
    if (!this.config.enableM2Choch) return;
    for (const bar of bars) {
      this.confirmedM2Bars.push({ ...bar, confirmed: true });
      const m2Sweeps = this.kzEngine.previewLiveSweeps(bar, this.confirmedM2Bars.length - 1);
      const signal = this.chochM2Engine.processConfirmedBar(bar);
      if (signal) {
        const alert = this.evaluateConfluence(
          bar, this.confirmedM2Bars.length - 1, signal,
          this.lastKzHighSweep, this.lastKzLowSweep, false, 'M2', m2Sweeps
        );
        if (alert) void this.recordAndDispatchAlert(alert, false);
      }
    }
    this.emit();
  }

  /** Updates the independent M2 stream; it is never fabricated from M3 candles. */
  public async ingestM2Bar(bar: Candle, isConfirmedClose: boolean) {
    if (!this.config.enableM2Choch) return;
    const last = this.confirmedM2Bars[this.confirmedM2Bars.length - 1];
    if (last && bar.time < last.time) return;
    if (last && bar.time === last.time) return;
    if (isConfirmedClose) {
      this.invalidateStoppedSetups(bar);
      if (this.liveM2Bar?.time === bar.time) this.liveM2Bar = null;
      this.confirmedM2Bars.push({ ...bar, confirmed: true });
      const m2Sweeps = this.kzEngine.previewLiveSweeps(bar, this.confirmedM2Bars.length - 1);
      const signal = this.chochM2Engine.processConfirmedBar(bar);
      if (signal) {
        const alert = this.evaluateConfluence(
          bar, this.confirmedM2Bars.length - 1, signal,
          this.lastKzHighSweep, this.lastKzLowSweep, false, 'M2', m2Sweeps
        );
        if (alert) await this.recordAndDispatchAlert(alert, true);
      }
    } else {
      if (this.liveM2Bar && bar.time > this.liveM2Bar.time) {
        const closed = { ...this.liveM2Bar, confirmed: true };
        this.confirmedM2Bars.push(closed);
        const m2Sweeps = this.kzEngine.previewLiveSweeps(closed, this.confirmedM2Bars.length - 1);
        const signal = this.chochM2Engine.processConfirmedBar(closed);
        if (signal) {
          const alert = this.evaluateConfluence(
            closed, this.confirmedM2Bars.length - 1, signal,
            this.lastKzHighSweep, this.lastKzLowSweep, false, 'M2', m2Sweeps
          );
          if (alert) await this.recordAndDispatchAlert(alert, true);
        }
      }
      this.liveM2Bar = bar;
      this.invalidateStoppedSetups(bar);
      if (this.config.triggerOnIntrabar) {
        const m2Sweeps = this.kzEngine.previewLiveSweeps(bar, this.confirmedM2Bars.length);
        const signal = this.chochM2Engine.previewLiveBar(bar);
        if (signal) {
          const alert = this.evaluateConfluence(
            bar, this.confirmedM2Bars.length, signal,
            this.lastKzHighSweep, this.lastKzLowSweep, true, 'M2', m2Sweeps
          );
          if (alert) await this.recordAndDispatchAlert(alert, true);
        }
      }
    }
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
      (patch.h4BiasMode !== undefined && patch.h4BiasMode !== this.config.h4BiasMode) ||
      (patch.enableM2Choch !== undefined && patch.enableM2Choch !== this.config.enableM2Choch);

    this.config = { ...this.config, ...patch };

    if (needsRecompute && (this.d1Bars.length > 0 || this.h4Bars.length > 0)) {
      this.loadHtfHistory(this.d1Bars, this.h4Bars, false);
    }

    if (needsRecompute && this.confirmedBars.length > 0) {
      const existingBars = [...this.confirmedBars];
      const existingLive = this.liveBar ? { ...this.liveBar } : null;
      this.loadHistory(existingBars, existingLive);
      if (this.confirmedM2Bars.length > 0) this.loadM2History([...this.confirmedM2Bars], this.liveM2Bar);
    } else {
      this.emit();
    }
  }

  private async processConfirmedBarInternal(bar: Candle, dispatchLiveWebhook: boolean) {
    const barIndex = this.confirmedBars.length;
    this.invalidateStoppedSetups(bar);
    this.confirmedBars.push({ ...bar, confirmed: true });

    const newSweeps = this.kzEngine.processBar(bar, barIndex);
    for (const sw of newSweeps) {
      if (sw.isHigh) {
        this.lastKzHighSweep = sw;
      } else {
        this.lastKzLowSweep = sw;
      }
    }

    const chochSignal = this.chochM3Engine.processConfirmedBar(bar);

    if (chochSignal) {
      const confluence = this.evaluateConfluence(
        bar,
        barIndex,
        chochSignal,
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
    this.invalidateStoppedSetups(liveBar);
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

    const liveCisd = this.chochM3Engine.previewLiveBar(liveBar);
    if (!liveCisd) return;

    const confluence = this.evaluateConfluence(
      liveBar,
      liveBarIndex,
      liveCisd,
      effectiveHighSweep,
      effectiveLowSweep,
      true,
      'M3',
      liveSweeps
    );

    if (confluence) {
      await this.recordAndDispatchAlert(confluence, true);
    }
  }

  /** A setup is invalidated only by a later candle touching its wick-based SL. */
  private invalidateStoppedSetups(bar: Candle) {
    let changed = false;
    for (const alert of this.confluenceAlerts) {
      if (alert.ackStatus === 'historical' || alert.ackStatus === 'invalidated' ||
          alert.invalidatedAt != null || bar.time <= alert.timestamp) continue;
      const touched = alert.direction === 'BEARISH' ? bar.high >= alert.stopLoss : bar.low <= alert.stopLoss;
      if (!touched) continue;
      alert.ackStatus = 'invalidated';
      alert.nextReminderAt = null;
      alert.invalidatedAt = bar.time;
      alert.retryUntil = bar.time + 60 * 60_000;
      alert.webhookDetail = `Setup invalide: Stop Loss touche. Surveillance d'un nouveau CHoCH jusqu'a ${new Date(alert.retryUntil).toISOString()}`;
      this.saveAckState(alert);
      changed = true;
    }
    if (changed) this.emit();
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
      confluence.invalidatedAt = saved.invalidatedAt ?? null;
      confluence.retryUntil = saved.retryUntil ?? null;
    }

    if (this.confluenceAlerts.some((a) => a.dedupeKey === confluence.dedupeKey)) return;
    this.confluenceAlerts.unshift(confluence);
    if (this.confluenceAlerts.length > 1500) {
      this.confluenceAlerts.length = 1500;
    }

    if (saved) {
      return;
    }

    const now = Date.now();
    const ageMs = now - confluence.timestamp;
    const isFreshLiveSetup = ageMs <= LIVE_ALERT_FRESHNESS_MS;
    if (!dispatchLiveWebhook || !isFreshLiveSetup) {
      confluence.ackStatus = 'historical';
      confluence.webhookStatus = 'skipped';
      confluence.webhookDetail =
        dispatchLiveWebhook && !isFreshLiveSetup
          ? 'Signal passe (> 6 min) — ignore'
          : 'Historique passe';
      return;
    }

    if (!this.config.alertsEnabled) {
      confluence.ackStatus = 'historical';
      confluence.webhookStatus = 'skipped';
      confluence.webhookDetail = 'Alertes desactivees';
      return;
    }

    // Fresh live ("en cours") alert -> enter pending validation state and dispatch immediately!
    confluence.ackStatus = 'pending';
    confluence.reminderCount = 1;
    confluence.lastReminderAt = now;
    confluence.nextReminderAt =
      MAX_ALERT_DELIVERIES > 1
        ? now + Math.max(10, this.config.repeatAlertIntervalSec) * 1000
        : null;
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
    choch: CisdSignal,
    highSweep: KillzoneSweepEvent | null,
    lowSweep: KillzoneSweepEvent | null,
    isIntrabarSignal: boolean,
    timeframe: 'M3' | 'M2' = 'M3',
    additionalSweeps: KillzoneSweepEvent[] = []
  ): ConfluenceAlert | null {
    const ny = getNyDateTime(bar.time, this.config.tzMode);
    const intervalMs = timeframe === 'M2' ? 2 * 60_000 : 3 * 60_000;
    const pendingGapSources = new Set(this.kzEngine.getPendingGapSourceSweepIds(bar.time));
    const allSweeps = [...this.kzEngine.getSweepEvents(), highSweep, lowSweep, ...additionalSweeps]
      .filter((x): x is KillzoneSweepEvent => !!x)
      .filter((x, i, arr) => arr.findIndex((y) => y.id === x.id) === i)
      .filter((sw) => !pendingGapSources.has(sw.id));
    const isBearish = choch.direction === 'bearish';
    // A valid setup starts when price sweeps a previously formed session high/low.
    // The source level may come from today's, yesterday's, or the previous NY day's
    // Asia/London/NY AM/NY PM range. The sweep itself may happen outside a Killzone.
    // Accept a matching CHoCH later on the same NY day as the sweep, whether it occurs
    // before or after the price retests/re-enters the swept level. Source level age: 0-2 days.
    const direction = isBearish ? 'BEARISH' : 'BULLISH';
    // Historical/backfilled alerts do not participate in live setup sequencing.
    // A live CHoCH consumes the sweeps that preceded it: another CHoCH cannot reuse
    // those old sweeps to manufacture an opposite or duplicate reversal signal.
    const latestLiveAlert = this.confluenceAlerts
      .filter((a) => a.ackStatus !== 'historical' && a.timeframe === timeframe)
      .sort((a, b) => b.timestamp - a.timestamp)[0] ?? null;

    // After a stop is hit, keep watching the original reversal direction for
    // 60 minutes. During that window, only a NEW matching-side sweep can restart
    // the setup. An opposite CHoCH is ignored even if older opposite-side sweeps exist.
    const activeRetry = this.confluenceAlerts
      .filter((a) => a.ackStatus === 'invalidated' && a.timeframe === timeframe && a.invalidatedAt != null &&
        a.retryUntil != null && bar.time > a.invalidatedAt && bar.time <= a.retryUntil)
      .sort((a, b) => (b.invalidatedAt ?? 0) - (a.invalidatedAt ?? 0))[0] ?? null;

    if (activeRetry && activeRetry.direction !== direction) return null;

    // Sweeps before the most recent live CHoCH are consumed. A retry requires a
    // sweep after the SL timestamp; after the 60-minute window, a fresh sweep
    // after expiry is mandatory before either direction can signal again.
    let sweepCutoff = latestLiveAlert?.timestamp ?? Number.NEGATIVE_INFINITY;
    if (activeRetry?.invalidatedAt != null) {
      sweepCutoff = Math.max(sweepCutoff, activeRetry.invalidatedAt);
    } else if (latestLiveAlert?.ackStatus === 'invalidated' && latestLiveAlert.retryUntil != null &&
               bar.time > latestLiveAlert.retryUntil) {
      sweepCutoff = Math.max(sweepCutoff, latestLiveAlert.retryUntil);
    }

    const candidates = allSweeps
      .filter((sw) => sw.isHigh === isBearish)
      .filter((sw) => sw.sweptAt > sweepCutoff && sw.sweptAt <= bar.time)
      .filter((sw) => getNyDateTime(sw.sweptAt, this.config.tzMode).dayKey === ny.dayKey)
      .filter((sw) => {
        const ageDays = nyCalendarDayDistance(sw.createdAt, bar.time, this.config.tzMode);
        return ageDays >= 0 && ageDays <= 2;
      })
      .sort((a, b) => a.sweptAt - b.sweptAt);
    if (candidates.length === 0) return null;

    const latestSweep = candidates[candidates.length - 1];
    // Attribute the CHoCH only to the latest sweep event (plus levels swept on the same bar).
    // Older unrelated session levels must not be bundled into a new alert.
    const responsibleSweeps = candidates.filter((sw) => sw.sweptAt === latestSweep.sweptAt);
    // Include sweep event IDs, not only source level IDs: the same level may be
    // swept again later and must represent a distinct opportunity.
    const sweepSignature = `${timeframe}_${responsibleSweeps.map((x) => `${x.levelId}_${x.sweptAt}`).sort().join('+')}_${direction}`;
    const dedupeKey = `${sweepSignature}_${choch.time}`;
    if (this.consumedSweepKeys.has(dedupeKey)) return null;
    this.consumedSweepKeys.add(dedupeKey);

    const closedInsideLevel = responsibleSweeps.every((sw) =>
      isBearish ? bar.close < sw.level : bar.close > sw.level
    );
    // Record the first real candle close that re-enters all responsible swept levels.
    // This is descriptive metadata only; it does not participate in signal eligibility.
    const timeframeBars = timeframe === 'M2' ? this.confirmedM2Bars : this.confirmedBars;
    const timeline = [...timeframeBars, bar]
      .filter((c, i, arr) => c.time >= latestSweep.sweptAt && c.time <= bar.time && arr.findIndex((x) => x.time === c.time) === i)
      .sort((a, b) => a.time - b.time);
    const reentryBar = timeline.find((c) => responsibleSweeps.every((sw) =>
      isBearish ? c.close < sw.level : c.close > sw.level
    )) ?? null;
    const sweepNy = getNyDateTime(latestSweep.sweptAt, this.config.tzMode);
    const chochNy = getNyDateTime(choch.time, this.config.tzMode);
    const reentryNy = reentryBar ? getNyDateTime(reentryBar.time, this.config.tzMode) : null;
    const { dailyBias, h4Bias, probability } = this.computeProbabilityAt(bar.time, direction);
    return {
      id: `conf_${timeframe}_${bar.time}_${barIndex}_${isIntrabarSignal ? 'live' : 'cls'}`,
      dedupeKey,
      timestamp: bar.time,
      nyTimeStr: ny.formatted,
      symbol: this.config.symbol,
      direction,
      activeKillzoneName: latestSweep.sessionName,
      dailyBias,
      h4Bias,
      probability,
      kzSweep: latestSweep,
      kzSweeps: responsibleSweeps,
      choch,
      timeframe,
      barsBetweenSweepAndChoch: Math.max(0, Math.floor((bar.time - latestSweep.sweptAt) / intervalMs)),
      closedInsideLevel,
      isPreReentry: !reentryBar,
      sweepTimeStr: sweepNy.formatted,
      chochTimeStr: chochNy.formatted,
      reentryTimeStr: reentryNy?.formatted ?? null,
      reentryAt: reentryBar?.time ?? null,
      reentryPrice: reentryBar?.close ?? null,
      isIntrabarSignal,
      hasInternalSwingSweep: choch.strongSweep,
      webhookStatus: 'skipped',
      webhookDetail: isIntrabarSignal ? `Temps reel ${timeframe}` : `Historique ${timeframe}`,
      ackStatus: 'historical',
      acknowledgedAt: null,
      acknowledgedBy: null,
      reminderCount: 0,
      lastReminderAt: null,
      nextReminderAt: null,
      stopLoss: isBearish ? Math.max(...responsibleSweeps.map((sw) => sw.sweepPrice)) : Math.min(...responsibleSweeps.map((sw) => sw.sweepPrice)),
      invalidatedAt: null,
      retryUntil: null,
    };
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
            createdAt: now - 24 * 60 * 60 * 1000,
            sweptAt: now - 180000,
            sweptBarIndex: Math.max(0, this.confirmedBars.length - 1),
            sweepPrice: Number((price + step).toFixed(decimals)),
          },
          choch: {
            id: 'test_choch',
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
          barsBetweenSweepAndChoch: 0,
          closedInsideLevel: false,
          isPreReentry: true,
          sweepTimeStr: ny.formatted,
          chochTimeStr: ny.formatted,
          reentryTimeStr: null,
          reentryAt: null,
          reentryPrice: null,
          isIntrabarSignal: true,
          hasInternalSwingSweep: true,
          webhookStatus: 'pending',
          ackStatus: 'acknowledged',
          acknowledgedAt: now,
          acknowledgedBy: 'ui',
          reminderCount: 1,
          lastReminderAt: now,
          nextReminderAt: null,
          stopLoss: htf.alignedDirection === 'BULLISH' ? price - step : price + step,
          invalidatedAt: null,
          retryUntil: null,
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

    const currentTrend = this.chochM3Engine.getCurrentTrend();
    const baseTrends = this.chochM3Engine.getCandleTrends();
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
        enableM2Choch: this.config.enableM2Choch,
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
      swingPivots: [],
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
