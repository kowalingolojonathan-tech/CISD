export type TimezoneMode = 'Auto (DST)' | 'Manual UTC-4 (EDT)' | 'Manual UTC-5 (EST)';

export type SupportedSymbol = 'XAU/USD' | 'EUR/USD';

export function getPriceDecimals(symbol: string): number {
  return symbol === 'EUR/USD' ? 5 : 2;
}

export function formatSymbolPrice(price: number, symbol: string): string {
  return price.toFixed(getPriceDecimals(symbol));
}

export type SessionId = 'asia' | 'london' | 'nyam' | 'nypm';

export interface Candle {
  time: number; // Unix timestamp in milliseconds (bar open time)
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
  confirmed?: boolean;
}

export interface SessionConfig {
  id: SessionId;
  name: string;
  shortName: string;
  range: string; // e.g. "2000-0000"
  color: string;
  enabled: boolean;
}

export interface SessionBox {
  uid: string;
  sessionId: SessionId;
  name: string;
  shortName: string;
  color: string;
  startTime: number;
  endTime: number;
  startIndex: number;
  endIndex: number;
  hi: number;
  lo: number;
  mid: number;
  open: number;
  close: number;
  live: boolean;
}

export interface UnsweptLevel {
  id: string;
  sessionId: SessionId;
  sessionName: string;
  shortName: string;
  color: string;
  isHigh: boolean;
  level: number;
  createdAt: number;
  createdBarIndex: number;
  swept: boolean;
  sweptAt: number | null;
  sweptBarIndex: number | null;
  isGapLiquidity?: boolean;
  sourceSweepId?: string;
}

export interface KillzoneSweepEvent {
  id: string;
  levelId: string;
  sessionId: SessionId;
  sessionName: string;
  shortName: string;
  isHigh: boolean;
  level: number;
  /** Timestamp when the source session level was created (session close). */
  createdAt: number;
  sweptAt: number;
  sweptBarIndex: number;
  sweepPrice: number;
  isGapLiquidity?: boolean;
  sourceSweepId?: string;
}

export interface SessionCountdown {
  activeSessionId: SessionId | null;
  activeSessionName: string | null;
  statusText: string;
  isWarning: boolean; // <= 15m left in active session
  nyTimeFormatted: string;
  nyTimezone: 'UTC-4' | 'UTC-5';
  isDst: boolean;
}

export interface SwingPivot {
  id: string;
  barIndex: number;
  time: number;
  type: 'high' | 'low';
  level: number;
  mitigated: boolean;
  mitigatedAt: number | null;
  mitigatedBarIndex: number | null;
  expired: boolean;
}

export interface CisdSignal {
  id: string;
  barIndex: number;
  time: number;
  direction: 'bearish' | 'bullish'; // 1 = bearish, 2 = bullish
  originLevel: number;
  originBarIndex: number;
  noiseRatio: number;
  toleranceUsed: number;
  strongSweep: boolean; // Fractal structure CHoCH
  wickedSwingLevel: number | null;
  barsSinceSwing: number | null;
  closePrice: number;
}

export type HtfBiasDirection = 'BULLISH' | 'BEARISH' | 'NEUTRAL';
export type HtfBiasMode = 'AUTO' | 'BULLISH' | 'BEARISH';
export type ProbabilityTier = 'HIGH' | 'MEDIUM' | 'COUNTER_TREND';

export interface HtfBiasState {
  daily: HtfBiasDirection;
  h4: HtfBiasDirection;
  dailyMode: HtfBiasMode;
  h4Mode: HtfBiasMode;
  dailyOriginLevel: number | null;
  h4OriginLevel: number | null;
  dailyLastTime: number | null;
  h4LastTime: number | null;
  alignedDirection: HtfBiasDirection | null; // non-null when D1 == H4 != NEUTRAL
}

export type AlertAckStatus = 'pending' | 'acknowledged' | 'expired' | 'invalidated' | 'historical';

export interface ConfluenceAlert {
  id: string;
  dedupeKey: string;
  timestamp: number;
  nyTimeStr: string;
  symbol: string;
  direction: 'BEARISH' | 'BULLISH';
  activeKillzoneName: string | null;
  dailyBias: HtfBiasDirection;
  h4Bias: HtfBiasDirection;
  probability: ProbabilityTier;
  kzSweep: KillzoneSweepEvent;
  choch: CisdSignal;
  /** Chart timeframe that produced this setup. */
  timeframe?: 'M2' | 'M3';
  /** All same-side session levels swept before this CHoCH (e.g. NY AM + NY PM). */
  kzSweeps?: KillzoneSweepEvent[];
  barsBetweenSweepAndChoch: number;
  closedInsideLevel: boolean;
  isPreReentry: boolean; // true = no close back inside the swept level before CHoCH
  /** Exact NY-local event timestamps captured when the setup is created. */
  sweepTimeStr?: string;
  chochTimeStr?: string;
  reentryTimeStr?: string | null;
  reentryAt?: number | null;
  reentryPrice?: number | null;
  isIntrabarSignal: boolean; // true = fired live before timeframe candle close
  hasInternalSwingSweep: boolean;
  webhookStatus: 'pending' | 'sent' | 'skipped' | 'failed';
  webhookDetail?: string;
  ackStatus: AlertAckStatus;
  acknowledgedAt: number | null;
  acknowledgedBy?: 'ui' | 'telegram' | null;
  reminderCount: number;
  lastReminderAt: number | null;
  nextReminderAt: number | null;
  /** Stop-loss at the extreme wick of the swept session level(s). */
  stopLoss?: number;
  /** Timestamp when the setup was invalidated by a post-CHoCH stop-loss touch. */
  invalidatedAt?: number | null;
  /** End of the 60-minute replacement-CHoCH observation window. */
  retryUntil?: number | null;
}

export type MarketSourceType = 'yahoo_swissquote' | 'twelvedata';

export interface EngineConfig {
  symbol: string;
  marketSource: MarketSourceType;
  twelveDataApiKey: string;
  tzMode: TimezoneMode;
  // LuxAlgo CHoCH fractal Market Structure parameters
  tolerance: number; // default 0.7
  swingPeriod: number; // default 12
  expiryBars: number; // default 100
  liquidityLookback: number; // default 10 (M3 bars)
  // Confluence & Killzone filtering
  kzLookbackBars: number; // legacy compatibility; sweep-to-CHoCH window is the same NY day
  requireActiveKillzone: boolean; // legacy setting; sweep must occur in Killzone, CHoCH may confirm later same NY day
  triggerOnIntrabar: boolean; // true = signal immediately on live M2/M3 tick before bar close
  // HTF Bias (Daily & H4)
  dailyBiasMode: HtfBiasMode;
  h4BiasMode: HtfBiasMode;
  highProbabilityOnly: boolean; // legacy compatibility flag; probability is now classification-only
  enableM2Choch: boolean; // run a separate M2 CHoCH engine alongside M3
  // Telegram / Webhook & Repeat Alerts
  telegramBotToken: string;
  telegramChatId: string;
  customWebhookUrl: string;
  alertsEnabled: boolean;
  repeatAlertIntervalSec: number; // reminder interval until acknowledgement, capped at 10 deliveries
  liveSetupMaxMinutes: number; // default 20m window while setup is still active/en cours
}

export interface KillzoneDaySummary {
  id: SessionId;
  name: string;
  shortName: string;
  range: string;
  color: string;
  enabled: boolean;
  active: boolean;
  occurredToday: boolean;
  hi: number | null;
  lo: number | null;
  open: number | null;
  close: number | null;
  rangePct: string;
  direction: 'up' | 'down' | 'flat';
}

export interface SymbolOverview {
  symbol: SupportedSymbol;
  price: number | null;
  dailyBias: HtfBiasDirection;
  h4Bias: HtfBiasDirection;
  confluenceCount: number;
  highProbCount: number;
  pendingAckCount?: number;
  connected: boolean;
}

export interface EngineSnapshot {
  config: Omit<EngineConfig, 'telegramBotToken' | 'twelveDataApiKey'> & {
    hasTelegramToken: boolean;
    telegramTokenMasked: string;
    hasTwelveDataKey: boolean;
  };
  htfBias: HtfBiasState;
  candles: Candle[];
  candleTrends: number[]; // 1, -1, or 0 aligned with candles
  sessions: SessionBox[];
  unsweptLevels: UnsweptLevel[];
  sweepEvents: KillzoneSweepEvent[];
  countdown: SessionCountdown;
  daySummaries: KillzoneDaySummary[];
  swingPivots: SwingPivot[];
  confluenceAlerts: ConfluenceAlert[];
  feedStatus: {
    source: MarketSourceType;
    connected: boolean;
    lastTickAt: number | null;
    lastError: string | null;
    barCount: number;
  };
  symbolsOverview?: SymbolOverview[];
  appUrl?: string;
}
