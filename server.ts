import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TradingConfluenceEngine } from './src/engine/confluence.ts';
import { MarketLiveFeed } from './src/engine/marketFeed.ts';
import {
  answerTelegramCallback,
  fetchTelegramUpdates,
  sendTelegramSimpleText,
} from './src/engine/telegram.ts';
import type {
  EngineConfig,
  EngineSnapshot,
  HtfBiasMode,
  SupportedSymbol,
  SymbolOverview,
} from './src/engine/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const RUNTIME_CONFIG_PATH = path.resolve(__dirname, '.runtime-config.json');

const SUPPORTED_SYMBOLS: SupportedSymbol[] = ['XAU/USD', 'EUR/USD'];

function resolveSymbol(raw: unknown): SupportedSymbol {
  return raw === 'EUR/USD' ? 'EUR/USD' : 'XAU/USD';
}

interface PersistedConfigFile extends Partial<EngineConfig> {
  htfOverrides?: Partial<
    Record<
      SupportedSymbol,
      {
        dailyBiasMode?: HtfBiasMode;
        h4BiasMode?: HtfBiasMode;
      }
    >
  >;
}

function loadPersistedConfig(): PersistedConfigFile {
  try {
    if (fs.existsSync(RUNTIME_CONFIG_PATH)) {
      const raw = fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf8');
      return JSON.parse(raw) as PersistedConfigFile;
    }
  } catch {
    // Ignore malformed persisted file
  }
  return {};
}

function savePersistedConfig(
  sharedCfg: EngineConfig,
  xauCfg: EngineConfig,
  eurCfg: EngineConfig
) {
  try {
    const payload: PersistedConfigFile = {
      tzMode: sharedCfg.tzMode,
      tolerance: sharedCfg.tolerance,
      swingPeriod: sharedCfg.swingPeriod,
      expiryBars: sharedCfg.expiryBars,
      liquidityLookback: sharedCfg.liquidityLookback,
      kzLookbackBars: sharedCfg.kzLookbackBars,
      requireActiveKillzone: sharedCfg.requireActiveKillzone,
      triggerOnIntrabar: sharedCfg.triggerOnIntrabar,
      highProbabilityOnly: sharedCfg.highProbabilityOnly,
      telegramBotToken: sharedCfg.telegramBotToken,
      telegramChatId: sharedCfg.telegramChatId,
      customWebhookUrl: sharedCfg.customWebhookUrl,
      alertsEnabled: sharedCfg.alertsEnabled,
      repeatAlertIntervalSec: sharedCfg.repeatAlertIntervalSec,
      liveSetupMaxMinutes: sharedCfg.liveSetupMaxMinutes,
      htfOverrides: {
        'XAU/USD': {
          dailyBiasMode: xauCfg.dailyBiasMode,
          h4BiasMode: xauCfg.h4BiasMode,
        },
        'EUR/USD': {
          dailyBiasMode: eurCfg.dailyBiasMode,
          h4BiasMode: eurCfg.h4BiasMode,
        },
      },
    };
    fs.writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(payload, null, 2), 'utf8');
  } catch {
    // Non-fatal persistence error
  }
}

const persisted = loadPersistedConfig();

function createInitialConfig(symbol: SupportedSymbol): EngineConfig {
  const htf = persisted.htfOverrides?.[symbol];
  return {
    symbol,
    marketSource: process.env.TWELVEDATA_API_KEY ? 'twelvedata' : 'yahoo_swissquote',
    twelveDataApiKey: process.env.TWELVEDATA_API_KEY ?? '',
    tzMode: persisted.tzMode ?? 'Auto (DST)',
    tolerance: persisted.tolerance ?? 0.7,
    swingPeriod: persisted.swingPeriod ?? 12,
    expiryBars: persisted.expiryBars ?? 100,
    liquidityLookback: persisted.liquidityLookback ?? 10,
    kzLookbackBars: persisted.kzLookbackBars ?? 10,
    requireActiveKillzone: persisted.requireActiveKillzone ?? true,
    triggerOnIntrabar: persisted.triggerOnIntrabar ?? true,
    dailyBiasMode: htf?.dailyBiasMode ?? (symbol === 'XAU/USD' ? persisted.dailyBiasMode ?? 'AUTO' : 'AUTO'),
    h4BiasMode: htf?.h4BiasMode ?? (symbol === 'XAU/USD' ? persisted.h4BiasMode ?? 'AUTO' : 'AUTO'),
    highProbabilityOnly: persisted.highProbabilityOnly ?? false,
    telegramBotToken: persisted.telegramBotToken || process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: persisted.telegramChatId || process.env.TELEGRAM_CHAT_ID || '',
    customWebhookUrl: persisted.customWebhookUrl ?? '',
    alertsEnabled: persisted.alertsEnabled ?? true,
    repeatAlertIntervalSec: persisted.repeatAlertIntervalSec ?? 30,
    liveSetupMaxMinutes: persisted.liveSetupMaxMinutes ?? 20,
  };
}

const engines: Record<SupportedSymbol, TradingConfluenceEngine> = {
  'XAU/USD': new TradingConfluenceEngine(createInitialConfig('XAU/USD')),
  'EUR/USD': new TradingConfluenceEngine(createInitialConfig('EUR/USD')),
};

const feeds: Record<SupportedSymbol, MarketLiveFeed> = {
  'XAU/USD': new MarketLiveFeed(engines['XAU/USD'], 'XAU/USD'),
  'EUR/USD': new MarketLiveFeed(engines['EUR/USD'], 'EUR/USD'),
};

function getSymbolsOverview(): SymbolOverview[] {
  return SUPPORTED_SYMBOLS.map((sym) => {
    const snap = engines[sym].getSnapshot();
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

function buildSnapshot(symbol: SupportedSymbol): EngineSnapshot {
  const snap = engines[symbol].getSnapshot();
  return {
    ...snap,
    symbolsOverview: getSymbolsOverview(),
    appUrl: process.env.APP_URL || '',
  };
}

const app = express();
app.use(express.json({ limit: '1mb' }));

// Health check & keep-alive endpoint
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    symbols: SUPPORTED_SYMBOLS,
    overview: getSymbolsOverview(),
  });
});

// Current full snapshot for selected symbol
app.get('/api/state', (req: Request, res: Response) => {
  const sym = resolveSymbol(req.query.symbol);
  res.json(buildSnapshot(sym));
});

// Server-Sent Events stream for real-time M3 candles, sweeps, CISD & confluence alerts
app.get('/api/stream', (req: Request, res: Response) => {
  const sym = resolveSymbol(req.query.symbol);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendSnapshot = () => {
    const snap = buildSnapshot(sym);
    res.write(`data: ${JSON.stringify(snap)}\n\n`);
  };

  sendSnapshot();

  const unsubscribePrimary = engines[sym].subscribe(() => {
    sendSnapshot();
  });

  const otherSym: SupportedSymbol = sym === 'XAU/USD' ? 'EUR/USD' : 'XAU/USD';
  let lastOverviewPush = 0;
  const unsubscribeOther = engines[otherSym].subscribe(() => {
    const now = Date.now();
    if (now - lastOverviewPush >= 4000) {
      lastOverviewPush = now;
      sendSnapshot();
    }
  });

  const keepAlive = setInterval(() => {
    res.write(`: ping\n\n`);
  }, 20000);

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribePrimary();
    unsubscribeOther();
  });
});

// Acknowledge ("J'ai vu / Valider") one or all live alerts so reminders stop immediately
app.post('/api/alerts/ack', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { id?: string; symbol?: string; all?: boolean };
  const sym = resolveSymbol(req.query.symbol ?? body.symbol);

  if (body.all) {
    let total = 0;
    for (const s of SUPPORTED_SYMBOLS) {
      total += engines[s].acknowledgeAllPending('ui');
    }
    res.json({ ok: true, acknowledgedCount: total, snapshot: buildSnapshot(sym) });
    return;
  }

  const identifier = typeof body.id === 'string' ? body.id.trim() : '';
  if (!identifier) {
    res.status(400).json({ ok: false, error: 'Identifiant alerte manquant' });
    return;
  }

  let matched = engines[sym].acknowledgeAlert(identifier, 'ui');
  if (!matched) {
    for (const s of SUPPORTED_SYMBOLS) {
      matched = engines[s].acknowledgeAlert(identifier, 'ui');
      if (matched) break;
    }
  }

  res.json({
    ok: true,
    acknowledgedCount: matched ? 1 : 0,
    snapshot: buildSnapshot(sym),
  });
});

// Update engine / indicator / webhook parameters
app.post('/api/config', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Partial<EngineConfig> & { symbol?: string };
    const sym = resolveSymbol(req.query.symbol ?? body.symbol);
    const prevSource = engines[sym].getConfig().marketSource;

    const sharedPatch: Partial<EngineConfig> = {};
    const symbolHtfPatch: Partial<EngineConfig> = {};

    if (body.marketSource === 'yahoo_swissquote' || body.marketSource === 'twelvedata') {
      sharedPatch.marketSource = body.marketSource;
    }
    if (
      body.tzMode === 'Auto (DST)' ||
      body.tzMode === 'Manual UTC-4 (EDT)' ||
      body.tzMode === 'Manual UTC-5 (EST)'
    ) {
      sharedPatch.tzMode = body.tzMode;
    }
    if (typeof body.tolerance === 'number' && body.tolerance >= 0 && body.tolerance <= 1) {
      sharedPatch.tolerance = body.tolerance;
    }
    if (typeof body.swingPeriod === 'number' && body.swingPeriod >= 3 && body.swingPeriod <= 50) {
      sharedPatch.swingPeriod = Math.round(body.swingPeriod);
    }
    if (typeof body.expiryBars === 'number' && body.expiryBars >= 20 && body.expiryBars <= 500) {
      sharedPatch.expiryBars = Math.round(body.expiryBars);
    }
    if (typeof body.liquidityLookback === 'number' && body.liquidityLookback >= 1 && body.liquidityLookback <= 50) {
      sharedPatch.liquidityLookback = Math.round(body.liquidityLookback);
    }
    if (typeof body.kzLookbackBars === 'number' && body.kzLookbackBars >= 1 && body.kzLookbackBars <= 60) {
      sharedPatch.kzLookbackBars = Math.round(body.kzLookbackBars);
    }
    if (typeof body.requireActiveKillzone === 'boolean') {
      sharedPatch.requireActiveKillzone = body.requireActiveKillzone;
    }
    if (typeof body.triggerOnIntrabar === 'boolean') {
      sharedPatch.triggerOnIntrabar = body.triggerOnIntrabar;
    }
    if (body.dailyBiasMode === 'AUTO' || body.dailyBiasMode === 'BULLISH' || body.dailyBiasMode === 'BEARISH') {
      symbolHtfPatch.dailyBiasMode = body.dailyBiasMode;
    }
    if (body.h4BiasMode === 'AUTO' || body.h4BiasMode === 'BULLISH' || body.h4BiasMode === 'BEARISH') {
      symbolHtfPatch.h4BiasMode = body.h4BiasMode;
    }
    if (typeof body.highProbabilityOnly === 'boolean') {
      sharedPatch.highProbabilityOnly = body.highProbabilityOnly;
    }
    if (typeof body.telegramBotToken === 'string' && body.telegramBotToken.trim().length > 0) {
      sharedPatch.telegramBotToken = body.telegramBotToken.trim();
    }
    if (typeof body.telegramChatId === 'string') {
      sharedPatch.telegramChatId = body.telegramChatId.trim();
    }
    if (typeof body.customWebhookUrl === 'string') {
      sharedPatch.customWebhookUrl = body.customWebhookUrl.trim();
    }
    if (typeof body.alertsEnabled === 'boolean') {
      sharedPatch.alertsEnabled = body.alertsEnabled;
    }
    if (
      typeof body.repeatAlertIntervalSec === 'number' &&
      body.repeatAlertIntervalSec >= 10 &&
      body.repeatAlertIntervalSec <= 300
    ) {
      sharedPatch.repeatAlertIntervalSec = Math.round(body.repeatAlertIntervalSec);
    }
    if (
      typeof body.liveSetupMaxMinutes === 'number' &&
      body.liveSetupMaxMinutes >= 5 &&
      body.liveSetupMaxMinutes <= 120
    ) {
      sharedPatch.liveSetupMaxMinutes = Math.round(body.liveSetupMaxMinutes);
    }

    await Promise.all(
      SUPPORTED_SYMBOLS.map((s) =>
        engines[s].updateConfig(s === sym ? { ...sharedPatch, ...symbolHtfPatch } : sharedPatch)
      )
    );

    const xauCfg = engines['XAU/USD'].getConfig();
    const eurCfg = engines['EUR/USD'].getConfig();
    savePersistedConfig(xauCfg, xauCfg, eurCfg);

    if (sharedPatch.marketSource && sharedPatch.marketSource !== prevSource) {
      await Promise.all(SUPPORTED_SYMBOLS.map((s) => feeds[s].reload()));
    }

    res.json({ ok: true, snapshot: buildSnapshot(sym) });
  } catch (err) {
    res.status(400).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// Force refresh real market data for selected symbol
app.post('/api/feed/refresh', async (req: Request, res: Response) => {
  const sym = resolveSymbol(req.query.symbol);
  await feeds[sym].reload();
  res.json({ ok: true, snapshot: buildSnapshot(sym) });
});

// Test Telegram / Webhook delivery
app.post('/api/webhook/test', async (req: Request, res: Response) => {
  const sym = resolveSymbol(req.query.symbol);
  const result = await engines[sym].sendTestWebhook();
  res.json(result);
});

// Inbound TradingView Webhook forwarder (optional bridge for Pine Script alerts -> Telegram)
app.post('/api/webhook/tradingview', async (req: Request, res: Response) => {
  const cfg = engines['XAU/USD'].getConfig();
  const payload = req.body;
  const text =
    typeof payload === 'string'
      ? payload
      : typeof payload?.message === 'string'
      ? payload.message
      : `<b>TradingView Webhook</b>\n<pre>${JSON.stringify(payload, null, 2)}</pre>`;

  if (!cfg.telegramBotToken || !cfg.telegramChatId) {
    res.status(400).json({ ok: false, error: 'Telegram Bot Token ou Chat ID non configure' });
    return;
  }

  try {
    const tgRes = await fetch(`https://api.telegram.org/bot${cfg.telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.telegramChatId,
        text,
        parse_mode: 'HTML',
      }),
    });
    const tgData = await tgRes.json();
    res.json({ ok: tgRes.ok, telegram: tgData });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

function startBackgroundLoops() {
  // 1. Repeat Telegram reminder loop every 5s for unacknowledged "en cours" alerts
  setInterval(() => {
    for (const s of SUPPORTED_SYMBOLS) {
      void engines[s].processPendingReminders();
    }
  }, 5000);

  // 2. Telegram getUpdates poller so clicking "✅ J'ai vu" or replying "vu/ok" on Telegram validates immediately
  let tgUpdateOffset = 0;
  let isPollingTg = false;
  setInterval(() => {
    if (isPollingTg) return;
    const cfg = engines['XAU/USD'].getConfig();
    if (!cfg.telegramBotToken.trim()) return;

    isPollingTg = true;
    void (async () => {
      try {
        const updates = await fetchTelegramUpdates(cfg.telegramBotToken, tgUpdateOffset);
        for (const u of updates) {
          if (u.update_id >= tgUpdateOffset) {
            tgUpdateOffset = u.update_id + 1;
          }

          const cb = u.callback_query;
          if (cb?.data && cb.data.startsWith('ack:')) {
            const parts = cb.data.split(':');
            const symRaw = parts[1];
            const identifier = parts[2] ?? '';
            const targetSym = resolveSymbol(symRaw);
            const matched =
              engines[targetSym].acknowledgeAlert(identifier, 'telegram') ??
              engines['XAU/USD'].acknowledgeAlert(identifier, 'telegram') ??
              engines['EUR/USD'].acknowledgeAlert(identifier, 'telegram');

            if (!matched) {
              // Fallback: acknowledge all pending on that symbol if exact ts was replaced
              engines[targetSym].acknowledgeAllPending('telegram');
            }

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
            for (const s of SUPPORTED_SYMBOLS) {
              total += engines[s].acknowledgeAllPending('telegram');
            }
            if (total > 0 && msgChatId) {
              await sendTelegramSimpleText(
                cfg.telegramBotToken,
                msgChatId,
                `✅ <b>Validation enregistree :</b> ${total} alerte(s) en cours marquee(s) comme vue(s). Les rappels sont arretes.`
              );
            }
          }
        }
      } finally {
        isPollingTg = false;
      }
    })();
  }, 3000);

  // 3. Server self keep-alive if APP_URL is configured
  const appUrl = (process.env.APP_URL ?? '').trim().replace(/\/+$/, '');
  if (appUrl) {
    setInterval(() => {
      void fetch(`${appUrl}/api/health`).catch(() => {
        // Ignore transient self-ping network issues
      });
    }, 4 * 60 * 1000);
  }
}

async function startServer() {
  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*all', (_req: Request, res: Response) => {
      const indexFile = path.join(distPath, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Build missing');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Killzone CISD Desk server listening on http://0.0.0.0:${PORT}`);
    void feeds['XAU/USD'].start();
    void feeds['EUR/USD'].start();
    startBackgroundLoops();
  });
}

void startServer();
