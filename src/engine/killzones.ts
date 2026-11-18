import type {
  Candle,
  KillzoneDaySummary,
  KillzoneSweepEvent,
  SessionBox,
  SessionConfig,
  SessionCountdown,
  SessionId,
  TimezoneMode,
  UnsweptLevel,
} from './types.ts';

export const DEFAULT_SESSIONS: SessionConfig[] = [
  { id: 'asia', name: 'Asia', shortName: 'A', range: '2000-0000', color: '#e91e63', enabled: true },
  { id: 'london', name: 'London', shortName: 'L', range: '0200-0500', color: '#00bcd4', enabled: true },
  { id: 'nyam', name: 'NY AM', shortName: 'NA', range: '0830-1100', color: '#ff5d00', enabled: true },
  { id: 'nypm', name: 'NY PM', shortName: 'NP', range: '1330-1600', color: '#2157f3', enabled: true },
];

/**
 * Exact Pine Script v6 f_resolve_tz() US DST resolver:
 * US DST starts 2nd Sunday of March, ends 1st Sunday of November.
 * Uses bar timestamp (UTC) so historical/replay bars resolve accurately.
 */
export function resolveNyOffsetHours(timestampMs: number, tzMode: TimezoneMode): -4 | -5 {
  if (tzMode === 'Manual UTC-4 (EDT)') return -4;
  if (tzMode === 'Manual UTC-5 (EST)') return -5;

  const d = new Date(timestampMs);
  const mo = d.getUTCMonth() + 1; // 1..12
  const dy = d.getUTCDate(); // 1..31
  const dw = d.getUTCDay(); // 0 = Sunday .. 6 = Saturday

  let isEdt = false;
  if (mo > 3 && mo < 11) {
    isEdt = true;
  } else if (mo === 3) {
    if (dy >= 8 && dy <= 14 && dw === 0) {
      isEdt = true;
    } else if (dy > 14) {
      isEdt = true;
    }
  } else if (mo === 11) {
    if (dy < 7 && dw !== 0) {
      isEdt = true;
    } else if (dy === 7 && dw !== 0) {
      isEdt = true;
    }
  }

  return isEdt ? -4 : -5;
}

export interface NyDateTime {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  minsOfDay: number;
  dayKey: string;
  tzLabel: 'UTC-4' | 'UTC-5';
  isDst: boolean;
  formatted: string;
}

export function getNyDateTime(timestampMs: number, tzMode: TimezoneMode): NyDateTime {
  const offsetHours = resolveNyOffsetHours(timestampMs, tzMode);
  const shifted = new Date(timestampMs + offsetHours * 3600 * 1000);

  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  const hour = shifted.getUTCHours();
  const minute = shifted.getUTCMinutes();
  const second = shifted.getUTCSeconds();
  const minsOfDay = hour * 60 + minute;

  const pad = (n: number) => String(n).padStart(2, '0');
  const dayKey = `${year}-${pad(month)}-${pad(day)}`;
  const tzLabel = offsetHours === -4 ? 'UTC-4' : 'UTC-5';
  const formatted = `${dayKey} ${pad(hour)}:${pad(minute)}:${pad(second)} ${offsetHours === -4 ? 'EDT' : 'EST'}`;

  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    minsOfDay,
    dayKey,
    tzLabel,
    isDst: offsetHours === -4,
    formatted,
  };
}

export function parseSessionRange(range: string): { startMins: number; endMins: number } {
  const [sStart, sEnd] = range.split('-');
  const parseHHMM = (hhmm: string) => {
    const h = Number.parseInt(hhmm.slice(0, 2), 10);
    const m = Number.parseInt(hhmm.slice(2, 4), 10);
    return (Number.isNaN(h) ? 0 : h) * 60 + (Number.isNaN(m) ? 0 : m);
  };
  const startMins = parseHHMM(sStart ?? '0000');
  let endMins = parseHHMM(sEnd ?? '0000');
  if (endMins === 0) endMins = 1440;
  return { startMins, endMins };
}

function formatDuration(totalMins: number): string {
  const safe = Math.max(totalMins, 0);
  const h = Math.floor(safe / 60);
  const m = safe - h * 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function computeSessionCountdown(
  timestampMs: number,
  tzMode: TimezoneMode,
  sessions: SessionConfig[] = DEFAULT_SESSIONS
): SessionCountdown {
  const ny = getNyDateTime(timestampMs, tzMode);
  const curMins = ny.minsOfDay;

  for (const s of sessions) {
    if (!s.enabled) continue;
    const { startMins, endMins } = parseSessionRange(s.range);
    if (curMins >= startMins && curMins < endMins) {
      const left = endMins - curMins;
      return {
        activeSessionId: s.id,
        activeSessionName: s.name,
        statusText: `${s.name} · ${formatDuration(left)} restantes`,
        isWarning: left <= 15 && left > 0,
        nyTimeFormatted: ny.formatted,
        nyTimezone: ny.tzLabel,
        isDst: ny.isDst,
      };
    }
  }

  let bestDiff = 99999;
  let bestName = '';
  for (const s of sessions) {
    if (!s.enabled) continue;
    const { startMins } = parseSessionRange(s.range);
    let diff = startMins - curMins;
    if (diff < 0) diff += 1440;
    if (diff > 0 && diff < bestDiff) {
      bestDiff = diff;
      bestName = s.name;
    }
  }

  return {
    activeSessionId: null,
    activeSessionName: null,
    statusText: bestName ? `${bestName} dans ${formatDuration(bestDiff)}` : 'Aucune session',
    isWarning: false,
    nyTimeFormatted: ny.formatted,
    nyTimezone: ny.tzLabel,
    isDst: ny.isDst,
  };
}

interface InternalSessionSlot {
  config: SessionConfig;
  active: boolean;
  prevActive: boolean;
  occurredToday: boolean;
  hi: number;
  lo: number;
  mid: number;
  open: number;
  close: number;
  startTime: number;
  live: boolean;
  currentBoxIndex: number | null;
}

export class KillzonesEngine {
  private sessionsConfig: SessionConfig[];
  private tzMode: TimezoneMode;
  private slots: InternalSessionSlot[];
  private boxes: SessionBox[] = [];
  private unsweptLevels: UnsweptLevel[] = [];
  private sweepEvents: KillzoneSweepEvent[] = [];
  private currentDayKey: string | null = null;
  private uidCounter = 0;

  constructor(tzMode: TimezoneMode = 'Auto (DST)', sessions: SessionConfig[] = DEFAULT_SESSIONS) {
    this.tzMode = tzMode;
    this.sessionsConfig = sessions.map((s) => ({ ...s }));
    this.slots = this.sessionsConfig.map((cfg) => ({
      config: cfg,
      active: false,
      prevActive: false,
      occurredToday: false,
      hi: 0,
      lo: 0,
      mid: 0,
      open: 0,
      close: 0,
      startTime: 0,
      live: false,
      currentBoxIndex: null,
    }));
  }

  public reset(tzMode?: TimezoneMode) {
    if (tzMode) this.tzMode = tzMode;
    this.boxes = [];
    this.unsweptLevels = [];
    this.sweepEvents = [];
    this.currentDayKey = null;
    this.uidCounter = 0;
    this.slots = this.sessionsConfig.map((cfg) => ({
      config: cfg,
      active: false,
      prevActive: false,
      occurredToday: false,
      hi: 0,
      lo: 0,
      mid: 0,
      open: 0,
      close: 0,
      startTime: 0,
      live: false,
      currentBoxIndex: null,
    }));
  }

  public processBar(bar: Candle, barIndex: number): KillzoneSweepEvent[] {
    const ny = getNyDateTime(bar.time, this.tzMode);

    if (this.currentDayKey !== null && ny.dayKey !== this.currentDayKey) {
      for (const slot of this.slots) {
        slot.occurredToday = false;
      }
    }
    this.currentDayKey = ny.dayKey;

    for (const slot of this.slots) {
      const { startMins, endMins } = parseSessionRange(slot.config.range);
      const curInSession = slot.config.enabled && ny.minsOfDay >= startMins && ny.minsOfDay < endMins;

      slot.prevActive = slot.active;
      slot.active = curInSession;

      const isNew = slot.active && !slot.prevActive;
      const isAlive = slot.active;
      const isEnd = !slot.active && slot.prevActive;

      if (isNew) {
        slot.occurredToday = true;
        slot.hi = bar.high;
        slot.lo = bar.low;
        slot.mid = (bar.high + bar.low) / 2;
        slot.open = bar.open;
        slot.close = bar.close;
        slot.startTime = bar.time;
        slot.live = true;

        const box: SessionBox = {
          uid: `box_${++this.uidCounter}`,
          sessionId: slot.config.id,
          name: slot.config.name,
          shortName: slot.config.shortName,
          color: slot.config.color,
          startTime: bar.time,
          endTime: bar.time,
          startIndex: barIndex,
          endIndex: barIndex,
          hi: bar.high,
          lo: bar.low,
          mid: (bar.high + bar.low) / 2,
          open: bar.open,
          close: bar.close,
          live: true,
        };
        this.boxes.push(box);
        slot.currentBoxIndex = this.boxes.length - 1;
      } else if (isAlive) {
        slot.hi = Math.max(bar.high, slot.hi);
        slot.lo = Math.min(bar.low, slot.lo);
        slot.mid = (slot.hi + slot.lo) / 2;
        slot.close = bar.close;

        if (slot.currentBoxIndex !== null && this.boxes[slot.currentBoxIndex]) {
          const b = this.boxes[slot.currentBoxIndex];
          b.hi = slot.hi;
          b.lo = slot.lo;
          b.mid = slot.mid;
          b.close = slot.close;
          b.endTime = bar.time;
          b.endIndex = barIndex;
        }
      }

      if (isEnd) {
        slot.live = false;
        if (slot.currentBoxIndex !== null && this.boxes[slot.currentBoxIndex]) {
          this.boxes[slot.currentBoxIndex].live = false;
        }

        if (slot.hi > 0 && slot.lo > 0) {
          this.unsweptLevels.push({
            id: `lvl_${++this.uidCounter}`,
            sessionId: slot.config.id,
            sessionName: slot.config.name,
            shortName: slot.config.shortName,
            color: slot.config.color,
            isHigh: true,
            level: slot.hi,
            createdAt: bar.time,
            createdBarIndex: barIndex,
            swept: false,
            sweptAt: null,
            sweptBarIndex: null,
          });

          this.unsweptLevels.push({
            id: `lvl_${++this.uidCounter}`,
            sessionId: slot.config.id,
            sessionName: slot.config.name,
            shortName: slot.config.shortName,
            color: slot.config.color,
            isHigh: false,
            level: slot.lo,
            createdAt: bar.time,
            createdBarIndex: barIndex,
            swept: false,
            sweptAt: null,
            sweptBarIndex: null,
          });
        }
      }
    }

    // Unswept Level Sweep Detection (exact match to Pine Script lines 313-336)
    const newSweeps: KillzoneSweepEvent[] = [];
    for (const lvl of this.unsweptLevels) {
      if (lvl.swept) continue;
      const touched = lvl.isHigh ? bar.high >= lvl.level : bar.low <= lvl.level;
      if (touched) {
        lvl.swept = true;
        lvl.sweptAt = bar.time;
        lvl.sweptBarIndex = barIndex;
        const evt: KillzoneSweepEvent = {
          id: `swp_${++this.uidCounter}`,
          levelId: lvl.id,
          sessionId: lvl.sessionId,
          sessionName: lvl.sessionName,
          shortName: lvl.shortName,
          isHigh: lvl.isHigh,
          level: lvl.level,
          sweptAt: bar.time,
          sweptBarIndex: barIndex,
          sweepPrice: lvl.isHigh ? bar.high : bar.low,
        };
        newSweeps.push(evt);
        this.sweepEvents.unshift(evt);
      }
    }

    if (this.sweepEvents.length > 200) {
      this.sweepEvents.length = 200;
    }

    return newSweeps;
  }

  public getActiveSessionAt(timestampMs: number): SessionConfig | null {
    const ny = getNyDateTime(timestampMs, this.tzMode);
    for (const slot of this.slots) {
      if (!slot.config.enabled) continue;
      const { startMins, endMins } = parseSessionRange(slot.config.range);
      if (ny.minsOfDay >= startMins && ny.minsOfDay < endMins) {
        return slot.config;
      }
    }
    return null;
  }

  public previewLiveSweeps(liveBar: Candle, liveBarIndex: number): KillzoneSweepEvent[] {
    const hits: KillzoneSweepEvent[] = [];
    for (const lvl of this.unsweptLevels) {
      if (lvl.swept) continue;
      const touched = lvl.isHigh ? liveBar.high >= lvl.level : liveBar.low <= lvl.level;
      if (touched) {
        hits.push({
          id: `live_swp_${lvl.id}`,
          levelId: lvl.id,
          sessionId: lvl.sessionId,
          sessionName: lvl.sessionName,
          shortName: lvl.shortName,
          isHigh: lvl.isHigh,
          level: lvl.level,
          sweptAt: liveBar.time,
          sweptBarIndex: liveBarIndex,
          sweepPrice: lvl.isHigh ? liveBar.high : liveBar.low,
        });
      }
    }
    return hits;
  }

  public getBoxes(): SessionBox[] {
    return this.boxes;
  }

  public getUnsweptLevels(): UnsweptLevel[] {
    return this.unsweptLevels;
  }

  public getActiveUnsweptLevels(): UnsweptLevel[] {
    return this.unsweptLevels.filter((l) => !l.swept);
  }

  public getSweepEvents(): KillzoneSweepEvent[] {
    return this.sweepEvents;
  }

  public getDaySummaries(latestClose: number): KillzoneDaySummary[] {
    return this.slots.map((slot) => {
      const hasData = slot.occurredToday && slot.hi > 0 && slot.lo > 0;
      const effClose = slot.active ? latestClose : slot.close;
      let rangePct = '-';
      let direction: 'up' | 'down' | 'flat' = 'flat';
      if (hasData && slot.lo > 0 && slot.hi > slot.lo) {
        const mag = ((slot.hi - slot.lo) / slot.lo) * 100;
        const sgn = effClose > slot.open ? '+' : effClose < slot.open ? '-' : '';
        direction = effClose > slot.open ? 'up' : effClose < slot.open ? 'down' : 'flat';
        rangePct = `${sgn}${mag < 1 ? mag.toFixed(2) : mag.toFixed(1)}%`;
      }
      return {
        id: slot.config.id,
        name: slot.config.name,
        shortName: slot.config.shortName,
        range: slot.config.range,
        color: slot.config.color,
        enabled: slot.config.enabled,
        active: slot.active,
        occurredToday: slot.occurredToday,
        hi: hasData ? slot.hi : null,
        lo: hasData ? slot.lo : null,
        open: hasData ? slot.open : null,
        close: hasData ? effClose : null,
        rangePct,
        direction,
      };
    });
  }
}
