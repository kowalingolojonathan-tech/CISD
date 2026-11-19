import 'dotenv/config';
import crypto from 'crypto';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { EngineHub, resolveSymbol, type HubStorage, type PersistedConfigFile } from './src/engine/hub.ts';
import {
  getPushStore,
  initPushStore,
  isPushConfigured,
  sendPushForAlert,
  sendPushTest,
} from './src/engine/push.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const RUNTIME_CONFIG_PATH = path.resolve(__dirname, '.runtime-config.json');
const PUSH_TOKENS_PATH = path.resolve(__dirname, '.push-tokens.json');

// Optional shared secret protecting every /api route except /api/health.
const ACCESS_TOKEN = (process.env.ACCESS_TOKEN ?? '').trim();
// Extra browser origins allowed to call the API (comma separated, '*' = any).
const EXTRA_CORS_ORIGINS = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

initPushStore(PUSH_TOKENS_PATH);

const fileStorage: HubStorage = {
  load(): PersistedConfigFile {
    try {
      if (fs.existsSync(RUNTIME_CONFIG_PATH)) {
        return JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf8')) as PersistedConfigFile;
      }
    } catch {
      // Ignore malformed persisted file
    }
    return {};
  },
  save(data) {
    fs.writeFileSync(RUNTIME_CONFIG_PATH, JSON.stringify(data, null, 2), 'utf8');
  },
};

// Native push goes out the instant an alert is due (in parallel with Telegram, never awaited).
const hub = new EngineHub({
  storage: fileStorage,
  env: {
    twelveDataApiKey: process.env.TWELVEDATA_API_KEY,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
    appUrl: process.env.APP_URL,
  },
  onAlert: (alert, reminderNumber) => {
    void sendPushForAlert(alert, reminderNumber).then((r) => {
      if (r.configured && r.failed > 0) console.warn(`[push] ${r.detail}`);
    });
  },
});

const app = express();
app.use(express.json({ limit: '1mb' }));

function isAllowedOrigin(origin: string): boolean {
  if (EXTRA_CORS_ORIGINS.includes('*') || EXTRA_CORS_ORIGINS.includes(origin)) return true;
  // Capacitor WebView origins (Android: https://localhost, iOS: capacitor://localhost)
  return /^(https?|capacitor|ionic):\/\/localhost(:\d+)?$/.test(origin);
}

// CORS: lets the Android app (bundled web assets) reach this server.
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (typeof origin === 'string' && isAllowedOrigin(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-access-token, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Optional access token. Without ACCESS_TOKEN the API stays open.
app.use('/api', (req: Request, res: Response, next: NextFunction) => {
  if (!ACCESS_TOKEN || req.path === '/health') {
    next();
    return;
  }
  const header = req.headers['x-access-token'];
  const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
  const query = typeof req.query.token === 'string' ? req.query.token : '';
  const provided = (typeof header === 'string' ? header : '') || bearer || query;
  if (provided && safeEqual(provided, ACCESS_TOKEN)) {
    next();
    return;
  }
  res.status(401).json({ ok: false, error: 'unauthorized' });
});

// --- Native push (Android APK in server mode) ---
app.get('/api/push/status', (_req: Request, res: Response) => {
  res.json({ ok: true, configured: isPushConfigured(), devices: getPushStore().count() });
});

app.post('/api/push/register', (req: Request, res: Response) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  if (!getPushStore().add(token)) {
    res.status(400).json({ ok: false, error: 'Token invalide' });
    return;
  }
  res.json({ ok: true, configured: isPushConfigured(), devices: getPushStore().count() });
});

app.post('/api/push/unregister', (req: Request, res: Response) => {
  const token = typeof req.body?.token === 'string' ? req.body.token : '';
  res.json({ ok: true, removed: getPushStore().remove(token) });
});

app.post('/api/push/test', async (_req: Request, res: Response) => {
  const result = await sendPushTest();
  res.json({ ok: result.sent > 0, ...result });
});

// Health check & keep-alive endpoint
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    symbols: ['XAU/USD', 'EUR/USD'],
    overview: hub.getSymbolsOverview(),
  });
});

// Current full snapshot for selected symbol
app.get('/api/state', (req: Request, res: Response) => {
  res.json(hub.buildSnapshot(resolveSymbol(req.query.symbol)));
});

// Server-Sent Events stream for real-time M3 candles, sweeps, CISD & confluence alerts
app.get('/api/stream', (req: Request, res: Response) => {
  const sym = resolveSymbol(req.query.symbol);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering so events arrive instantly
  res.flushHeaders?.();

  const unsubscribe = hub.subscribe(sym, (snap) => {
    res.write(`data: ${JSON.stringify(snap)}\n\n`);
  });
  const keepAlive = setInterval(() => res.write(`: ping\n\n`), 20000);

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

// Acknowledge ("J'ai vu / Valider") one or all live alerts so reminders stop immediately
app.post('/api/alerts/ack', (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { id?: string; symbol?: string; all?: boolean };
  const result = hub.acknowledge(resolveSymbol(req.query.symbol ?? body.symbol), body);
  res.status(result.ok ? 200 : 400).json(result);
});

// Update engine / indicator / webhook parameters
app.post('/api/config', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Record<string, unknown> & { symbol?: string };
    const sym = resolveSymbol(req.query.symbol ?? body.symbol);
    res.json({ ok: true, snapshot: await hub.updateConfig(sym, body) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

// Force refresh real market data for selected symbol
app.post('/api/feed/refresh', async (req: Request, res: Response) => {
  const sym = resolveSymbol(req.query.symbol);
  res.json({ ok: true, snapshot: await hub.refreshFeed(sym) });
});

// Test Telegram / Webhook / Push delivery
app.post('/api/webhook/test', async (req: Request, res: Response) => {
  const sym = resolveSymbol(req.query.symbol);
  const [result, push] = await Promise.all([hub.testWebhook(sym), sendPushTest()]);
  res.json({
    ...result,
    ok: result.ok || push.sent > 0,
    detail: push.configured ? `${result.detail} | ${push.detail}` : result.detail,
  });
});

// Inbound TradingView Webhook forwarder (optional bridge for Pine Script alerts -> Telegram)
app.post('/api/webhook/tradingview', async (req: Request, res: Response) => {
  const cfg = hub.engines['XAU/USD'].getConfig();
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
      body: JSON.stringify({ chat_id: cfg.telegramChatId, text, parse_mode: 'HTML' }),
      signal: AbortSignal.timeout(8000),
    });
    const tgData = await tgRes.json();
    res.json({ ok: tgRes.ok, telegram: tgData });
  } catch (err) {
    res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
});

async function startServer() {
  if (!IS_PROD) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({ server: { middlewareMode: true }, appType: 'spa' });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*all', (_req: Request, res: Response) => {
      const indexFile = path.join(distPath, 'index.html');
      if (fs.existsSync(indexFile)) res.sendFile(indexFile);
      else res.status(404).send('Build missing');
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Killzone CISD Desk server listening on http://0.0.0.0:${PORT}`);
    hub.start();

    // Server self keep-alive if APP_URL is configured
    const appUrl = (process.env.APP_URL ?? '').trim().replace(/\/+$/, '');
    if (appUrl) {
      setInterval(() => {
        void fetch(`${appUrl}/api/health`, { signal: AbortSignal.timeout(8000) }).catch(() => {});
      }, 4 * 60 * 1000);
    }
  });
}

void startServer();
