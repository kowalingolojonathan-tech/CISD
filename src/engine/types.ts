export type TimezoneMode = 'Auto (DST)' | 'Manual UTC-4 (EDT)' | 'Manual UTC-5 (EST)';

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
}

export interface KillzoneSweepEvent {
  id: string;
  levelId: string;
  sessionId: SessionId;
  sessionName: string;
  shortName: string;
  isHigh: boolean;
  level: number;
  sweptAt: number;
  sweptBarIndex: number;
  sweepPrice: number;
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
  strongSweep: boolean; // AlgoAlpha internal swing sweep + CISD
  wickedSwingLevel: number | null;
  barsSinceSwing: number | null;
  closePrice: number;
}

export interface ConfluenceAlert {
  id: string;
  timestamp: number;
  nyTimeStr: string;
  symbol: string;
  direction: 'BEARISH' | 'BULLISH';
  kzSweep: KillzoneSweepEvent;
  cisd: CisdSignal;
  barsBetweenSweepAndCisd: number;
  closedInsideLevel: boolean;
  hasInternalSwingSweep: boolean;
  webhookStatus: 'pending' | 'sent' | 'skipped' | 'failed';
  webhookDetail?: string;
}

export type MarketSourceType = 'yahoo_swissquote' | 'twelvedata';

export interface EngineConfig {
  symbol: string;
  marketSource: MarketSourceType;
  twelveDataApiKey: string;
  tzMode: TimezoneMode;
  // AlgoAlpha CISD M3 parameters
  tolerance: number; // default 0.7
  swingPeriod: number; // default 12
  expiryBars: number; // default 100
  liquidityLookback: number; // default 10 (M3 bars)
  // Confluence
  kzLookbackBars: number; // default 10 (M3 bars = 30 min)
  // Telegram / Webhook
  telegramBotToken: string;
  telegramChatId: string;
  customWebhookUrl: string;
  alertsEnabled: boolean;
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

export interface EngineSnapshot {
  config: Omit<EngineConfig, 'telegramBotToken' | 'twelveDataApiKey'> & {
    hasTelegramToken: boolean;
    telegramTokenMasked: string;
    hasTwelveDataKey: boolean;
  };
  candles: Candle[];
  candleTrends: number[]; // 1, -1, or 0 aligned with candles
  sessions: SessionBox[];
  unsweptLevels: UnsweptLevel[];
  sweepEvents: KillzoneSweepEvent[];
  countdown: SessionCountdown;
  daySummaries: KillzoneDaySummary[];
  swingPivots: SwingPivot[];
  cisdSignals: CisdSignal[];
  confluenceAlerts: ConfluenceAlert[];
  feedStatus: {
    source: MarketSourceType;
    connected: boolean;
    lastTickAt: number | null;
    lastError: string | null;
    barCount: number;
  };
}
