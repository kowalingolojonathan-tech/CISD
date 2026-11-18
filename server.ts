import 'dotenv/config';
import express from 'express';
import type { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TradingConfluenceEngine } from './src/engine/confluence.ts';
import { XauUsdLiveFeed } from './src/engine/marketFeed.ts';
import type { EngineConfig } from './src/engine/types.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';

const initialConfig: EngineConfig = {
  symbol: 'XAU/USD',
  marketSource: process.env.TWELVEDATA_API_KEY ? 'twelvedata' : 'yahoo_swissquote',
  twelveDataApiKey: process.env.TWELVEDATA_API_KEY ?? '',
  tzMode: 'Auto (DST)',
  tolerance: 0.7,
  swingPeriod: 12,
  expiryBars: 100,
  liquidityLookback: 10,
  kzLookbackBars: 10,
  telegramBotToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
  telegramChatId: process.env.TELEGRAM_CHAT_ID ?? '',
  customWebhookUrl: '',
  alertsEnabled: true,
};

const engine = new TradingConfluenceEngine(initialConfig);
const feed = new XauUsdLiveFeed(engine);

const app = express();
app.use(express.json({ limit: '1mb' }));

// Health check
app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true, symbol: 'XAU/USD' });
});

// Current full snapshot
app.get('/api/state', (_req: Request, res: Response) => {
  res.json(engine.getSnapshot());
});

// Server-Sent Events stream for real-time M3 candles, sweeps, CISD & confluence alerts
app.get('/api/stream', (req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const sendSnapshot = () => {
    const snap = engine.getSnapshot();
    res.write(`data: ${JSON.stringify(snap)}\n\n`);
  };

  sendSnapshot();

  const unsubscribe = engine.subscribe((snap) => {
    res.write(`data: ${JSON.stringify(snap)}\n\n`);
  });

  const keepAlive = setInterval(() => {
    res.write(`: ping\n\n`);
  }, 20000);

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

// Update engine / indicator / webhook parameters
app.post('/api/config', async (req: Request, res: Response) => {
  try {
    const body = (req.body ?? {}) as Partial<EngineConfig>;
    const prev = engine.getConfig();
    const patch: Partial<EngineConfig> = {};

    if (body.marketSource === 'yahoo_swissquote' || body.marketSource === 'twelvedata') {
      patch.marketSource = body.marketSource;
    }
    if (
      body.tzMode === 'Auto (DST)' ||
      body.tzMode === 'Manual UTC-4 (EDT)' ||
      body.tzMode === 'Manual UTC-5 (EST)'
    ) {
      patch.tzMode = body.tzMode;
    }
    if (typeof body.tolerance === 'number' && body.tolerance >= 0 && body.tolerance <= 1) {
      patch.tolerance = body.tolerance;
    }
    if (typeof body.swingPeriod === 'number' && body.swingPeriod >= 3 && body.swingPeriod <= 50) {
      patch.swingPeriod = Math.round(body.swingPeriod);
    }
    if (typeof body.expiryBars === 'number' && body.expiryBars >= 20 && body.expiryBars <= 500) {
      patch.expiryBars = Math.round(body.expiryBars);
    }
    if (typeof body.liquidityLookback === 'number' && body.liquidityLookback >= 1 && body.liquidityLookback <= 50) {
      patch.liquidityLookback = Math.round(body.liquidityLookback);
    }
    if (typeof body.kzLookbackBars === 'number' && body.kzLookbackBars >= 1 && body.kzLookbackBars <= 60) {
      patch.kzLookbackBars = Math.round(body.kzLookbackBars);
    }
    if (typeof body.telegramChatId === 'string') {
      patch.telegramChatId = body.telegramChatId;
    }
    if (typeof body.customWebhookUrl === 'string') {
      patch.customWebhookUrl = body.customWebhookUrl;
    }
    if (typeof body.alertsEnabled === 'boolean') {
      patch.alertsEnabled = body.alertsEnabled;
    }

    await engine.updateConfig(patch);

    const next = engine.getConfig();
    if (next.marketSource !== prev.marketSource) {
      await feed.reload();
    }

    res.json({ ok: true, snapshot: engine.getSnapshot() });
  } catch (err) {
    res.status(400).json({
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

// Force refresh real XAU/USD market data
app.post('/api/feed/refresh', async (_req: Request, res: Response) => {
  await feed.reload();
  res.json({ ok: true, snapshot: engine.getSnapshot() });
});

// Test Telegram / Webhook delivery
app.post('/api/webhook/test', async (_req: Request, res: Response) => {
  const result = await engine.sendTestWebhook();
  res.json(result);
});

// Inbound TradingView Webhook forwarder (optional bridge for Pine Script alerts -> Telegram)
app.post('/api/webhook/tradingview', async (req: Request, res: Response) => {
  const cfg = engine.getConfig();
  const payload = req.body;
  const text =
    typeof payload === 'string'
      ? payload
      : typeof payload?.message === 'string'
      ? payload.message
      : `<b>TradingView Webhook XAU/USD</b>\n<pre>${JSON.stringify(payload, null, 2)}</pre>`;

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
    void feed.start();
  });
}

void startServer();
