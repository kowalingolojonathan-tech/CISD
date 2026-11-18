import { TradingConfluenceEngine } from './confluence.ts';
import type { Candle } from './types.ts';

const THREE_MIN_MS = 3 * 60 * 1000;

function align3m(timestampMs: number): number {
  return Math.floor(timestampMs / THREE_MIN_MS) * THREE_MIN_MS;
}

interface YahooChartResponse {
  chart?: {
    result?: Array<{
      meta?: {
        regularMarketPrice?: number;
        regularMarketTime?: number;
        symbol?: string;
      };
      timestamp?: number[];
      indicators?: {
        quote?: Array<{
          open?: Array<number | null>;
          high?: Array<number | null>;
          low?: Array<number | null>;
          close?: Array<number | null>;
          volume?: Array<number | null>;
        }>;
      };
    }>;
    error?: { description?: string };
  };
}

interface SwissquoteEntry {
  spreadProfilePrices?: Array<{
    spreadProfile?: string;
    bid?: number;
    ask?: number;
  }>;
}

interface TwelveDataResponse {
  status?: string;
  message?: string;
  values?: Array<{
    datetime: string;
    open: string;
    high: string;
    low: string;
    close: string;
    volume?: string;
  }>;
}

/**
 * Fetches real 1m COMEX Gold (GC=F) candles from Yahoo Finance and aggregates them
 * into exact 3-minute (M3) OHLCV bars, keeping full 5-day history across all Killzones.
 */
async function fetchYahooXauM3History(): Promise<{ confirmed: Candle[]; live: Candle | null }> {
  const url = 'https://query1.finance.yahoo.com/v8/finance/chart/GC=F?interval=1m&range=5d';
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`Yahoo Finance HTTP ${res.status}`);
  }

  const json = (await res.json()) as YahooChartResponse;
  const result = json.chart?.result?.[0];
  if (!result || !result.timestamp || !result.indicators?.quote?.[0]) {
    throw new Error(json.chart?.error?.description ?? 'Donnees GC=F indisponibles');
  }

  const ts = result.timestamp;
  const quote = result.indicators.quote[0];
  const buckets = new Map<number, Candle>();

  for (let i = 0; i < ts.length; i++) {
    const o = quote.open?.[i];
    const h = quote.high?.[i];
    const l = quote.low?.[i];
    const c = quote.close?.[i];
    const v = quote.volume?.[i] ?? 0;

    if (o == null || h == null || l == null || c == null) continue;

    const tMs = ts[i] * 1000;
    const bucketTime = align3m(tMs);
    const existing = buckets.get(bucketTime);

    if (!existing) {
      buckets.set(bucketTime, {
        time: bucketTime,
        open: Number(o.toFixed(2)),
        high: Number(h.toFixed(2)),
        low: Number(l.toFixed(2)),
        close: Number(c.toFixed(2)),
        volume: v,
        confirmed: true,
      });
    } else {
      existing.high = Number(Math.max(existing.high, h).toFixed(2));
      existing.low = Number(Math.min(existing.low, l).toFixed(2));
      existing.close = Number(c.toFixed(2));
      existing.volume = (existing.volume ?? 0) + v;
    }
  }

  const sorted = Array.from(buckets.values()).sort((a, b) => a.time - b.time);
  if (sorted.length === 0) {
    throw new Error('Aucune bougie M3 valide retournee');
  }

  const nowBucket = align3m(Date.now());
  const last = sorted[sorted.length - 1];
  if (last.time >= nowBucket) {
    last.confirmed = false;
    return {
      confirmed: sorted.slice(0, -1),
      live: last,
    };
  }

  return {
    confirmed: sorted,
    live: null,
  };
}

/**
 * Fetches real-time institutional Spot XAU/USD Bid/Ask mid price from Swissquote public BBO feed.
 */
async function fetchSwissquoteSpotPrice(): Promise<number | null> {
  try {
    const res = await fetch(
      'https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/XAU/USD',
      { headers: { Accept: 'application/json' } }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as SwissquoteEntry[];
    const prices = data?.[0]?.spreadProfilePrices;
    if (!prices || prices.length === 0) return null;
    const prime = prices.find((p) => p.spreadProfile === 'prime') ?? prices[0];
    if (typeof prime.bid === 'number' && typeof prime.ask === 'number') {
      return Number(((prime.bid + prime.ask) / 2).toFixed(2));
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Fetches real M3 candles directly for XAU/USD via Twelve Data when user provides an API key.
 */
async function fetchTwelveDataXauM3(apiKey: string): Promise<{ confirmed: Candle[]; live: Candle | null }> {
  const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=3min&outputsize=500&timezone=UTC&apikey=${encodeURIComponent(
    apiKey.trim()
  )}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Twelve Data HTTP ${res.status}`);
  }
  const json = (await res.json()) as TwelveDataResponse;
  if (json.status === 'error' || !json.values) {
    throw new Error(json.message ?? 'Erreur API Twelve Data');
  }

  const bars: Candle[] = json.values
    .map((v) => {
      const iso = v.datetime.includes('T') ? `${v.datetime}Z` : `${v.datetime.replace(' ', 'T')}Z`;
      return {
        time: Date.parse(iso),
        open: Number.parseFloat(v.open),
        high: Number.parseFloat(v.high),
        low: Number.parseFloat(v.low),
        close: Number.parseFloat(v.close),
        volume: v.volume ? Number.parseFloat(v.volume) : 0,
        confirmed: true,
      };
    })
    .filter((b) => !Number.isNaN(b.time) && !Number.isNaN(b.close))
    .sort((a, b) => a.time - b.time);

  if (bars.length === 0) {
    throw new Error('Aucune bougie Twelve Data XAU/USD');
  }

  const nowBucket = align3m(Date.now());
  const last = bars[bars.length - 1];
  if (last.time >= nowBucket) {
    last.confirmed = false;
    return { confirmed: bars.slice(0, -1), live: last };
  }
  return { confirmed: bars, live: null };
}

export class XauUsdLiveFeed {
  private engine: TradingConfluenceEngine;
  private tickTimer: NodeJS.Timeout | null = null;
  private historySyncTimer: NodeJS.Timeout | null = null;
  private currentLiveBar: Candle | null = null;
  private lastKnownClose = 0;
  private isRunning = false;

  constructor(engine: TradingConfluenceEngine) {
    this.engine = engine;
  }

  public async start() {
    this.stop();
    this.isRunning = true;
    await this.loadInitialHistory();

    // Poll real-time Spot XAU/USD price every 3 seconds to build live M3 candle ticks
    this.tickTimer = setInterval(() => {
      void this.pollSpotTick();
    }, 3000);

    // Periodically reconcile M3 history every 60 seconds
    this.historySyncTimer = setInterval(() => {
      void this.syncLatestBars();
    }, 60000);
  }

  public stop() {
    this.isRunning = false;
    if (this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = null;
    }
    if (this.historySyncTimer) {
      clearInterval(this.historySyncTimer);
      this.historySyncTimer = null;
    }
  }

  public async reload() {
    await this.loadInitialHistory();
  }

  private async loadInitialHistory() {
    const cfg = this.engine.getConfig();
    try {
      const data =
        cfg.marketSource === 'twelvedata' && cfg.twelveDataApiKey.trim()
          ? await fetchTwelveDataXauM3(cfg.twelveDataApiKey)
          : await fetchYahooXauM3History();

      this.currentLiveBar = data.live;
      if (data.live) {
        this.lastKnownClose = data.live.close;
      } else if (data.confirmed.length > 0) {
        this.lastKnownClose = data.confirmed[data.confirmed.length - 1].close;
      }

      this.engine.loadHistory(data.confirmed, data.live);
      this.engine.setFeedStatus(true, Date.now(), null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.engine.setFeedStatus(false, null, msg);
    }
  }

  private async pollSpotTick() {
    if (!this.isRunning) return;
    const cfg = this.engine.getConfig();
    if (cfg.marketSource === 'twelvedata' && cfg.twelveDataApiKey.trim()) {
      // Twelve Data relies on 3min poll in syncLatestBars; still update Swissquote tick for live movement
    }

    const spotPrice = await fetchSwissquoteSpotPrice();
    if (spotPrice === null) return;

    const bucket = align3m(Date.now());
    this.lastKnownClose = spotPrice;

    if (!this.currentLiveBar) {
      this.currentLiveBar = {
        time: bucket,
        open: spotPrice,
        high: spotPrice,
        low: spotPrice,
        close: spotPrice,
        volume: 0,
        confirmed: false,
      };
      await this.engine.ingestLiveBar({ ...this.currentLiveBar }, false);
      this.engine.setFeedStatus(true, Date.now(), null);
      return;
    }

    if (bucket > this.currentLiveBar.time) {
      // Previous M3 bar has closed! Confirm it first, then open new M3 bar
      const closedBar: Candle = { ...this.currentLiveBar, confirmed: true };
      await this.engine.ingestLiveBar(closedBar, true);

      this.currentLiveBar = {
        time: bucket,
        open: spotPrice,
        high: spotPrice,
        low: spotPrice,
        close: spotPrice,
        volume: 0,
        confirmed: false,
      };
      await this.engine.ingestLiveBar({ ...this.currentLiveBar }, false);
    } else {
      this.currentLiveBar = {
        ...this.currentLiveBar,
        high: Number(Math.max(this.currentLiveBar.high, spotPrice).toFixed(2)),
        low: Number(Math.min(this.currentLiveBar.low, spotPrice).toFixed(2)),
        close: spotPrice,
        confirmed: false,
      };
      await this.engine.ingestLiveBar({ ...this.currentLiveBar }, false);
    }

    this.engine.setFeedStatus(true, Date.now(), null);
  }

  private async syncLatestBars() {
    if (!this.isRunning) return;
    const cfg = this.engine.getConfig();
    try {
      const data =
        cfg.marketSource === 'twelvedata' && cfg.twelveDataApiKey.trim()
          ? await fetchTwelveDataXauM3(cfg.twelveDataApiKey)
          : await fetchYahooXauM3History();

      const snap = this.engine.getSnapshot();
      const lastConfirmedTime =
        snap.candles.length > 0
          ? snap.candles.filter((c) => c.confirmed !== false).slice(-1)[0]?.time ?? 0
          : 0;

      for (const bar of data.confirmed) {
        if (bar.time > lastConfirmedTime) {
          await this.engine.ingestLiveBar(bar, true);
        }
      }

      if (data.live && (!this.currentLiveBar || data.live.time >= this.currentLiveBar.time)) {
        if (!this.currentLiveBar || data.live.time > this.currentLiveBar.time) {
          this.currentLiveBar = data.live;
        } else {
          this.currentLiveBar = {
            ...this.currentLiveBar,
            high: Math.max(this.currentLiveBar.high, data.live.high),
            low: Math.min(this.currentLiveBar.low, data.live.low),
            close: this.lastKnownClose || data.live.close,
          };
        }
        await this.engine.ingestLiveBar({ ...this.currentLiveBar }, false);
      }

      this.engine.setFeedStatus(true, Date.now(), null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.engine.setFeedStatus(false, null, msg);
    }
  }
}
