import { TradingConfluenceEngine } from './confluence.ts';
import { MarketLiveFeed } from './marketFeed.ts';
import {
  answerTelegramCallback,
  fetchTelegramUpdates,
  sendTelegramSimpleText,
} from './telegram.ts';
import type {
  ConfluenceAlert,
  EngineConfig,
  EngineSnapshot,
  HtfBiasMode,
  SupportedSymbol,
  SymbolOverview,
} from './types.ts';

/**
 * Everything the server used to do inline, as a reusable class.
 * It runs unchanged in Node (server) and inside the Android app (on-device mode).
 * No Node-only API is used here.
 */

export const SUPPORTED_SYMBOLS: SupportedSymbol[] = ['XAU/USD', 'EUR/USD'];

export function resolveSymbol(raw: unknown): SupportedSymbol {
  return raw === 'EUR/USD' ? 'EUR/USD' : 'XAU/USD';
}

export interface PersistedConfigFile extends Partial<EngineConfig> {
  htfOverrides?: Partial<
    Record<SupportedSymbol, { dailyBiasMode?: HtfBiasMode; h4BiasMode?: HtfBiasMode }>
  >;
}

export interface HubStorage {
  load(): PersistedConfigFile;
  save(data: PersistedConfigFile): void;
}

export interface HubEnv {
  twelveDataApiKey?: string;
  telegramBotToken?: string;
  telegramChatId?: string;
  appUrl?: string;
}

export interface HubOptions {
  storage: HubStorage;
  env?: HubEnv;
  /** Fired the instant a live alert (or reminder) is due, before Telegram is awaited. */
  onAlert?: (alert: ConfluenceAlert, reminderNumber: number) => void;
}

export interface AckResult {
  ok: boolean;
  error?: string;
  acknowledgedCount?: number;
  snapshot?: EngineSnapshot;
}

type Timer = ReturnType<typeof setInterval>;

export class EngineHub {
  public readonly engines: Record<SupportedSymbol, TradingConfluenceEngine>;
  public readonly feeds: Record<SupportedSymbol, MarketLiveFeed>;

  private readonly storage: HubStorage;
  private readonly env: HubEnv;
  private readonly persisted: PersistedConfigFile;
  private timers: Timer[] = [];
  private tgUpdateOffset = 0;
  private isPollingTg = false;

  constructor(opts: HubOptions) {
    this.storage = opts.storage;
    this.env = opts.env ?? {};
    this.persisted = this.safeLoad();

    this.engines = {
      'XAU/USD': new TradingConfluenceEngine(this.createInitialConfig('XAU/USD')),
      'EUR/USD': new TradingConfluenceEngine(this.createInitialConfig('EUR/USD')),
    };
    this.feeds = {
      'XAU/USD': new MarketLiveFeed(this.engines['XAU/USD'], 'XAU/USD'),
      'EUR/USD': new MarketLiveFeed(this.engines['EUR/USD'], 'EUR/USD'),
    };

    if (opts.onAlert) {
      for (const sym of SUPPORTED_SYMBOLS) {
        this.engines[sym].setAlertNotifier(opts.onAlert);
      }
    }
  }

  /* ------------------------------- config ------------------------------- */

  private safeLoad(): PersistedConfigFile {
    try {
      return this.storage.load() ?? {};
    } catch {
      return {};
    }
  }

  private createInitialConfig(symbol: SupportedSymbol): EngineConfig {
    const p = this.persisted;
    const htf = p.htfOverrides?.[symbol];
    return {
      symbol,
      marketSource: this.env.twelveDataApiKey ? 'twelvedata' : 'yahoo_swissquote',
      twelveDataApiKey: this.env.twelveDataApiKey ?? '',
      tzMode: p.tzMode ?? 'Auto (DST)',
      tolerance: p.tolerance ?? 0.7,
      swingPeriod: p.swingPeriod ?? 12,
      expiryBars: p.expiryBars ?? 100,
      liquidityLookback: p.liquidityLookback ?? 10,
      kzLookbackBars: p.kzLookbackBars ?? 10,
      requireActiveKillzone: p.requireActiveKillzone ?? true,
      triggerOnIntrabar: p.triggerOnIntrabar ?? true,
      dailyBiasMode:
        htf?.dailyBiasMode ?? (symbol === 'XAU/USD' ? p.dailyBiasMode ?? 'AUTO' : 'AUTO'),
      h4BiasMode: htf?.h4BiasMode ?? (symbol === 'XAU/USD' ? p.h4BiasMode ?? 'AUTO' : 'AUTO'),
      highProbabilityOnly: p.highProbabilityOnly ?? false,
      telegramBotToken: p.telegramBotToken || this.env.telegramBotToken || '',
      telegramChatId: p.telegramChatId || this.env.telegramChatId || '',
      customWebhookUrl: p.customWebhookUrl ?? '',
      alertsEnabled: p.alertsEnabled ?? true,
      repeatAlertIntervalSec: p.repeatAlertIntervalSec ?? 30,
      liveSetupMaxMinutes: p.liveSetupMaxMinutes ?? 20,
    };
  }

  private persist() {
    try {
      const xau = this.engines['XAU/USD'].getConfig();
      const eur = this.engines['EUR/USD'].getConfig();
      this.storage.save({
        tzMode: xau.tzMode,
        tolerance: xau.tolerance,
        swingPeriod: xau.swingPeriod,
        expiryBars: xau.expiryBars,
        liquidityLookback: xau.liquidityLookback,
        kzLookbackBars: xau.kzLookbackBars,
        requireActiveKillzone: xau.requireActiveKillzone,
        triggerOnIntrabar: xau.triggerOnIntrabar,
        highProbabilityOnly: xau.highProbabilityOnly,
        telegramBotToken: xau.telegramBotToken,
        telegramChatId: xau.telegramChatId,
        customWebhookUrl: xau.customWebhookUrl,
        alertsEnabled: xau.alertsEnabled,
        repeatAlertIntervalSec: xau.repeatAlertIntervalSec,
        liveSetupMaxMinutes: xau.liveSetupMaxMinutes,
        htfOverrides: {
          'XAU/USD': { dailyBiasMode: xau.dailyBiasMode, h4BiasMode: xau.h4BiasMode },
          'EUR/USD': { dailyBiasMode: eur.dailyBiasMode, h4BiasMode: eur.h4BiasMode },
        },
      });
    } catch {
      // Non-fatal persistence error
    }
  }

  /* ------------------------------ snapshots ----------------------------- */

  public getSymbolsOverview(): SymbolOverview[] {
    return SUPPORTED_SYMBOLS.map((sym) => {
      const snap = this.engines[sym].getSnapshot();
      const lastCandle = snap.candles[snap.candles.length - 1];
      return {
        symbol: sym,
        price: lastCandle ? lastCandle.close : null,
        dailyBias: snap.htfBias.daily,
        h4Bias: snap.htfBias.h4,
        confluenceCount: snap.confluenceAlerts.length,
        highProbCount: snap.confluenceAlerts.filter((a) => a.probability === 'HIGH').length,
        pendingAckCount: snap.confluenceAlerts.filter((a) => a.ackStatus === 'pending').length,
        connected: snap.feedStatus.connected,
      };
    });
  }

  public buildSnapshot(symbol: SupportedSymbol): EngineSnapshot {
    return {
      ...this.engines[symbol].getSnapshot(),
      symbolsOverview: this.getSymbolsOverview(),
      appUrl: this.env.appUrl ?? '',
    };
  }

  /**
   * Streams snapshots of one symbol (the other symbol refreshes the overview at most every 4 s).
   * Calls `cb` once immediately. Returns the unsubscribe function.
   */
  public subscribe(symbol: SupportedSymbol, cb: (snapshot: EngineSnapshot) => void): () => void {
    const send = () => cb(this.buildSnapshot(symbol));
    send();

    const unsubPrimary = this.engines[symbol].subscribe(send);

    const other: SupportedSymbol = symbol === 'XAU/USD' ? 'EUR/USD' : 'XAU/USD';
    let lastOverviewPush = 0;
    const unsubOther = this.engines[other].subscribe(() => {
      const now = Date.now();
      if (now - lastOverviewPush >= 4000) {
        lastOverviewPush = now;
        send();
      }
    });

    return () => {
      unsubPrimary();
      unsubOther();
    };
  }

  /* ------------------------------- actions ------------------------------ */

  public acknowledge(symbol: SupportedSymbol, opts: { id?: unknown; all?: unknown }): AckResult {
    if (opts.all) {
      let total = 0;
      for (const s of SUPPORTED_SYMBOLS) total += this.engines[s].acknowledgeAllPending('ui');
      return { ok: true, acknowledgedCount: total, snapshot: this.buildSnapshot(symbol) };
    }

    const identifier = typeof opts.id === 'string' ? opts.id.trim() : '';
    if (!identifier) return { ok: false, error: 'Identifiant alerte manquant' };

    let matched = this.engines[symbol].acknowledgeAlert(identifier, 'ui');
    if (!matched) {
      for (const s of SUPPORTED_SYMBOLS) {
        matched = this.engines[s].acknowledgeAlert(identifier, 'ui');
        if (matched) break;
      }
    }
    return { ok: true, acknowledgedCount: matched ? 1 : 0, snapshot: this.buildSnapshot(symbol) };
  }

  /** Validates and applies a settings patch. Throws on a bad payload. */
  public async updateConfig(symbol: SupportedSymbol, body: Partial<EngineConfig>): Promise<EngineSnapshot> {
    const prevSource = this.engines[symbol].getConfig().marketSource;
    const shared: Partial<EngineConfig> = {};
    const htf: Partial<EngineConfig> = {};

    if (body.marketSource === 'yahoo_swissquote' || body.marketSource === 'twelvedata') {
      shared.marketSource = body.marketSource;
    }
    if (
      body.tzMode === 'Auto (DST)' ||
      body.tzMode === 'Manual UTC-4 (EDT)' ||
      body.tzMode === 'Manual UTC-5 (EST)'
    ) {
      shared.tzMode = body.tzMode;
    }
    const num = (v: unknown, min: number, max: number): number | undefined =>
      typeof v === 'number' && v >= min && v <= max ? v : undefined;

    const tol = num(body.tolerance, 0, 1);
    if (tol !== undefined) shared.tolerance = tol;
    const swing = num(body.swingPeriod, 3, 50);
    if (swing !== undefined) shared.swingPeriod = Math.round(swing);
    const expiry = num(body.expiryBars, 20, 500);
    if (expiry !== undefined) shared.expiryBars = Math.round(expiry);
    const liq = num(body.liquidityLookback, 1, 50);
    if (liq !== undefined) shared.liquidityLookback = Math.round(liq);
    const kz = num(body.kzLookbackBars, 1, 60);
    if (kz !== undefined) shared.kzLookbackBars = Math.round(kz);
    if (typeof body.requireActiveKillzone === 'boolean') shared.requireActiveKillzone = body.requireActiveKillzone;
    if (typeof body.triggerOnIntrabar === 'boolean') shared.triggerOnIntrabar = body.triggerOnIntrabar;
    if (body.dailyBiasMode === 'AUTO' || body.dailyBiasMode === 'BULLISH' || body.dailyBiasMode === 'BEARISH') {
      htf.dailyBiasMode = body.dailyBiasMode;
    }
    if (body.h4BiasMode === 'AUTO' || body.h4BiasMode === 'BULLISH' || body.h4BiasMode === 'BEARISH') {
      htf.h4BiasMode = body.h4BiasMode;
    }
    if (typeof body.highProbabilityOnly === 'boolean') shared.highProbabilityOnly = body.highProbabilityOnly;
    if (typeof body.telegramBotToken === 'string' && body.telegramBotToken.trim().length > 0) {
      shared.telegramBotToken = body.telegramBotToken.trim();
    }
    if (typeof body.telegramChatId === 'string') shared.telegramChatId = body.telegramChatId.trim();
    if (typeof body.customWebhookUrl === 'string') shared.customWebhookUrl = body.customWebhookUrl.trim();
    if (typeof body.alertsEnabled === 'boolean') shared.alertsEnabled = body.alertsEnabled;
    const rep = num(body.repeatAlertIntervalSec, 10, 300);
    if (rep !== undefined) shared.repeatAlertIntervalSec = Math.round(rep);
    const live = num(body.liveSetupMaxMinutes, 5, 120);
    if (live !== undefined) shared.liveSetupMaxMinutes = Math.round(live);

    await Promise.all(
      SUPPORTED_SYMBOLS.map((s) =>
        this.engines[s].updateConfig(s === symbol ? { ...shared, ...htf } : shared)
      )
    );
    this.persist();

    if (shared.marketSource && shared.marketSource !== prevSource) {
      await Promise.all(SUPPORTED_SYMBOLS.map((s) => this.feeds[s].reload()));
    }
    return this.buildSnapshot(symbol);
  }

  public async refreshFeed(symbol: SupportedSymbol): Promise<EngineSnapshot> {
    await this.feeds[symbol].reload();
    return this.buildSnapshot(symbol);
  }

  public testWebhook(symbol: SupportedSymbol) {
    return this.engines[symbol].sendTestWebhook();
  }

  /* --------------------------- background loops -------------------------- */

  public start() {
    this.stop();
    void this.feeds['XAU/USD'].start();
    void this.feeds['EUR/USD'].start();

    // Repeat reminders for unacknowledged live alerts
    this.timers.push(
      setInterval(() => {
        for (const s of SUPPORTED_SYMBOLS) void this.engines[s].processPendingReminders();
      }, 5000)
    );

    // Telegram getUpdates poller: "J'ai vu" button / "vu" reply validates immediately
    this.timers.push(setInterval(() => void this.pollTelegram(), 3000));
  }

  public stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    for (const s of SUPPORTED_SYMBOLS) this.feeds[s].stop();
  }

  private async pollTelegram() {
    if (this.isPollingTg) return;
    const cfg = this.engines['XAU/USD'].getConfig();
    if (!cfg.telegramBotToken.trim()) return;

    this.isPollingTg = true;
    try {
      const updates = await fetchTelegramUpdates(cfg.telegramBotToken, this.tgUpdateOffset);
      for (const u of updates) {
        if (u.update_id >= this.tgUpdateOffset) this.tgUpdateOffset = u.update_id + 1;

        const cb = u.callback_query;
        if (cb?.data && cb.data.startsWith('ack:')) {
          const parts = cb.data.split(':');
          const targetSym = resolveSymbol(parts[1]);
          const identifier = parts[2] ?? '';
          const matched =
            this.engines[targetSym].acknowledgeAlert(identifier, 'telegram') ??
            this.engines['XAU/USD'].acknowledgeAlert(identifier, 'telegram') ??
            this.engines['EUR/USD'].acknowledgeAlert(identifier, 'telegram');
          if (!matched) this.engines[targetSym].acknowledgeAllPending('telegram');

          await answerTelegramCallback(
            cfg.telegramBotToken,
            cb.id,
            "✅ Alerte validee (J'ai vu) — Rappels arretes.",
            cb.message?.chat?.id,
            cb.message?.message_id
          );
          continue;
        }

        const msgText = u.message?.text?.trim() ?? '';
        const msgChatId = u.message?.chat?.id ? String(u.message.chat.id) : '';
        if (
          msgText &&
          /^(ok|vu|stop|\/vu|valide|valider|j'ai vu)$/i.test(msgText) &&
          (!cfg.telegramChatId || msgChatId === cfg.telegramChatId.trim())
        ) {
          let total = 0;
          for (const s of SUPPORTED_SYMBOLS) total += this.engines[s].acknowledgeAllPending('telegram');
          if (total > 0 && msgChatId) {
            await sendTelegramSimpleText(
              cfg.telegramBotToken,
              msgChatId,
              `✅ <b>Validation enregistree :</b> ${total} alerte(s) en cours marquee(s) comme vue(s). Les rappels sont arretes.`
            );
          }
        }
      }
    } catch {
      // Transient Telegram/network error: retry on the next tick
    } finally {
      this.isPollingTg = false;
    }
  }
}
