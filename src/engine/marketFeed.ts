import { TradingConfluenceEngine } from './confluence.ts';
import { getPriceDecimals, type Candle, type SupportedSymbol } from './types.ts';

const THREE_MIN_MS = 3 * 60 * 1000;

function align3m(timestampMs: number): number {
  return Math.floor(timestampMs / THREE_MIN_MS) * THREE_MIN_MS;
}

function roundPrice(val: number, symbol: SupportedSymbol): number {
  return Number(val.toFixed(getPriceDecimals(symbol)));
}

function getYahooTicker(symbol: SupportedSymbol): string {
  return symbol === 'EUR/USD' ? 'EURUSD=X' : 'GC=F';
}

function getSwissquotePath(symbol: SupportedSymbol): string {
  return symbol === 'EUR/USD' ? 'EUR/USD' : 'XAU/USD';
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

async function fetchYahooM3History(
  symbol: SupportedSymbol
): Promise<{ confirmed: Candle[]; live: Candle | null }> {
  const ticker = getYahooTicker(symbol);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
    ticker
  )}?interval=1m&range=5d`;
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`Yahoo Finance (${ticker}) HTTP ${res.status}`);
  }

  const json = (await res.json()) as YahooChartResponse;
  const result = json.chart?.result?.[0];
  if (!result || !result.timestamp || !result.indicators?.quote?.[0]) {
    throw new Error(json.chart?.error?.description ?? `Donnees ${symbol} indisponibles`);
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
        open: roundPrice(o, symbol),
        high: roundPrice(h, symbol),
        low: roundPrice(l, symbol),
        close: roundPrice(c, symbol),
        volume: v,
        confirmed: true,
      });
    } else {
      existing.high = roundPrice(Math.max(existing.high, h), symbol);
      existing.low = roundPrice(Math.min(existing.low, l), symbol);
      existing.close = roundPrice(c, symbol);
      existing.volume = (existing.volume ?? 0) + v;
    }
  }

  const sorted = Array.from(buckets.values()).sort((a, b) => a.time - b.time);
  if (sorted.length === 0) {
    throw new Error(`Aucune bougie M3 valide pour ${symbol}`);
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

async function fetchSwissquoteSpotPrice(symbol: SupportedSymbol): Promise<number | null> {
  try {
    const res = await fetch(
      `https://forex-data-feed.swissquote.com/public-quotes/bboquotes/instrument/${getSwissquotePath(
        symbol
      )}`,
      { headers: { Accept: 'application/json' } }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as SwissquoteEntry[];
    const prices = data?.[0]?.spreadProfilePrices;
    if (!prices || prices.length === 0) return null;
    const prime = prices.find((p) => p.spreadProfile === 'prime') ?? prices[0];
    if (typeof prime.bid === 'number' && typeof prime.ask === 'number') {
      return roundPrice((prime.bid + prime.ask) / 2, symbol);
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchTwelveDataM3(
  symbol: SupportedSymbol,
  apiKey: string
): Promise<{ confirmed: Candle[]; live: Candle | null }> {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(
    symbol
  )}&interval=3min&outputsize=500&timezone=UTC&apikey=${encodeURIComponent(apiKey.trim())}`;
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
        open: roundPrice(Number.parseFloat(v.open), symbol),
        high: roundPrice(Number.parseFloat(v.high), symbol),
        low: roundPrice(Number.parseFloat(v.low), symbol),
        close: roundPrice(Number.parseFloat(v.close), symbol),
        volume: v.volume ? Number.parseFloat(v.volume) : 0,
        confirmed: true,
      };
    })
    .filter((b) => !Number.isNaN(b.time) && !Number.isNaN(b.close))
    .sort((a, b) => a.time - b.time);

  if (bars.length === 0) {
    throw new Error(`Aucune bougie Twelve Data ${symbol}`);
  }

  const nowBucket = align3m(Date.now());
  const last = bars[bars.length - 1];
  if (last.time >= nowBucket) {
    last.confirmed = false;
    return { confirmed: bars.slice(0, -1), live: last };
  }
  return { confirmed: bars, live: null };
}

async function fetchYahooHtfHistory(
  symbol: SupportedSymbol
): Promise<{ d1Bars: Candle[]; h4Bars: Candle[] }> {
  const ticker = encodeURIComponent(getYahooTicker(symbol));
  const headers = {
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
    Accept: 'application/json',
  };

  const [d1Res, h1Res] = await Promise.all([
    fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=6mo`, {
      headers,
    }),
    fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1h&range=1mo`, {
      headers,
    }),
  ]);

  const parseYahoo = (json: YahooChartResponse): Candle[] => {
    const r = json.chart?.result?.[0];
    if (!r?.timestamp || !r.indicators?.quote?.[0]) return [];
    const ts = r.timestamp;
    const q = r.indicators.quote[0];
    const out: Candle[] = [];
    for (let i = 0; i < ts.length; i++) {
      const o = q.open?.[i];
      const h = q.high?.[i];
      const l = q.low?.[i];
      const c = q.close?.[i];
      if (o == null || h == null || l == null || c == null) continue;
      out.push({
        time: ts[i] * 1000,
        open: roundPrice(o, symbol),
        high: roundPrice(h, symbol),
        low: roundPrice(l, symbol),
        close: roundPrice(c, symbol),
        volume: q.volume?.[i] ?? 0,
        confirmed: true,
      });
    }
    return out.sort((a, b) => a.time - b.time);
  };

  const d1Bars = d1Res.ok ? parseYahoo((await d1Res.json()) as YahooChartResponse) : [];
  const h1Bars = h1Res.ok ? parseYahoo((await h1Res.json()) as YahooChartResponse) : [];

  const fourHourMs = 4 * 3600 * 1000;
  const h4Map = new Map<number, Candle>();
  for (const b of h1Bars) {
    const bucket = Math.floor(b.time / fourHourMs) * fourHourMs;
    const existing = h4Map.get(bucket);
    if (!existing) {
      h4Map.set(bucket, { ...b, time: bucket });
    } else {
      existing.high = roundPrice(Math.max(existing.high, b.high), symbol);
      existing.low = roundPrice(Math.min(existing.low, b.low), symbol);
      existing.close = b.close;
      existing.volume = (existing.volume ?? 0) + (b.volume ?? 0);
    }
  }
  const h4Bars = Array.from(h4Map.values()).sort((a, b) => a.time - b.time);

  return { d1Bars, h4Bars };
}

export class MarketLiveFeed {
  private engine: TradingConfluenceEngine;
  private symbol: SupportedSymbol;
  private tickTimer: NodeJS.Timeout | null = null;
  private historySyncTimer: NodeJS.Timeout | null = null;
  private currentLiveBar: Candle | null = null;
  private lastKnownClose = 0;
  private isRunning = false;

  constructor(engine: TradingConfluenceEngine, symbol: SupportedSymbol) {
    this.engine = engine;
    this.symbol = symbol;
  }

  public async start() {
    this.stop();
    this.isRunning = true;
    await this.loadInitialHistory();

    this.tickTimer = setInterval(() => {
      void this.pollSpotTick();
    }, 3000);

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
      const [data, htf] = await Promise.all([
        cfg.marketSource === 'twelvedata' && cfg.twelveDataApiKey.trim()
          ? fetchTwelveDataM3(this.symbol, cfg.twelveDataApiKey)
          : fetchYahooM3History(this.symbol),
        fetchYahooHtfHistory(this.symbol).catch(() => ({ d1Bars: [], h4Bars: [] })),
      ]);

      this.currentLiveBar = data.live;
      if (data.live) {
        this.lastKnownClose = data.live.close;
      } else if (data.confirmed.length > 0) {
        this.lastKnownClose = data.confirmed[data.confirmed.length - 1].close;
      }

      this.engine.loadHtfHistory(htf.d1Bars, htf.h4Bars, false);
      this.engine.loadHistory(data.confirmed, data.live);
      this.engine.setFeedStatus(true, Date.now(), null);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.engine.setFeedStatus(false, null, msg);
    }
  }

  private async pollSpotTick() {
    if (!this.isRunning) return;
    const spotPrice = await fetchSwissquoteSpotPrice(this.symbol);
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
        high: roundPrice(Math.max(this.currentLiveBar.high, spotPrice), this.symbol),
        low: roundPrice(Math.min(this.currentLiveBar.low, spotPrice), this.symbol),
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
      const [data, htf] = await Promise.all([
        cfg.marketSource === 'twelvedata' && cfg.twelveDataApiKey.trim()
          ? fetchTwelveDataM3(this.symbol, cfg.twelveDataApiKey)
          : fetchYahooM3History(this.symbol),
        fetchYahooHtfHistory(this.symbol).catch(() => ({ d1Bars: [], h4Bars: [] })),
      ]);

      if (htf.d1Bars.length > 0 || htf.h4Bars.length > 0) {
        this.engine.loadHtfHistory(htf.d1Bars, htf.h4Bars, true);
      }

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
