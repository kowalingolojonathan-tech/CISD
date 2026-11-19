import { formatSymbolPrice, type ConfluenceAlert } from './types.ts';

export interface AlertNotification {
  title: string;
  body: string;
  /** Stable per alert: duplicate notifications for the same setup replace instead of stacking. */
  tag: string;
}

/** Detailed event trace shared by Android local notifications and FCM push. */
export function buildAlertNotification(alert: ConfluenceAlert, reminderNumber = 1): AlertNotification {
  const fmt = (p: number | null | undefined) =>
    typeof p === 'number' && Number.isFinite(p) ? formatSymbolPrice(p, alert.symbol) : '—';
  const stopLoss = alert.stopLoss ?? alert.kzSweep?.sweepPrice ?? alert.kzSweep?.level;
  const bullish = alert.direction === 'BULLISH';
  const arrow = bullish ? '\u25B2' : '\u25BC';
  const dir = bullish ? 'HAUSSIER' : 'BAISSIER';
  const star = alert.probability === 'HIGH' ? ' · HAUTE PROBA' : alert.probability === 'MEDIUM' ? ' · MOYENNE' : ' · CONTRE-TENDANCE';
  const sweeps = alert.kzSweeps?.length ? alert.kzSweeps : [alert.kzSweep];
  const timeframe = alert.timeframe ?? 'M3';
  const prefix = reminderNumber > 1 ? `Rappel #${reminderNumber} · ` : '';
  const sweepDetails = sweeps.map((sw) =>
    `${sw.sessionName} ${sw.isHigh ? 'HIGH' : 'LOW'}: niveau ${fmt(sw.level)}, cassure ${fmt(sw.sweepPrice)} (${alert.sweepTimeStr ?? alert.nyTimeStr})`
  ).join(' | ');
  const reentry = alert.reentryAt != null
    ? `Réintégration: ${alert.reentryTimeStr ?? 'heure indisponible'} à ${fmt(alert.reentryPrice)}`
    : 'Réintégration: pas encore observée avant le CHoCH';
  const phase = alert.isPreReentry ? 'CHoCH AVANT réintégration' : 'CHoCH APRÈS réintégration';
  return {
    title: `${prefix}${arrow} ${alert.symbol} ${timeframe} · ${dir}${star}`,
    body: [
      `Date/heure NY: ${alert.nyTimeStr}`,
      `Cassure: ${sweepDetails}`,
      `CHoCH ${timeframe}: ${alert.chochTimeStr ?? alert.nyTimeStr} · ${fmt(alert.choch?.closePrice)} (structure ${fmt(alert.choch?.originLevel)})`,
      `${phase} · ${reentry}`,
      `Daily: ${alert.dailyBias} · H4: ${alert.h4Bias}`,
      `SL: ${fmt(stopLoss)} · Killzone active: ${alert.activeKillzoneName ?? 'Hors session'}`,
    ].join('\n'),
    tag: alert.dedupeKey.replace(/[^a-zA-Z0-9_-]/g, '_'),
  };
}
