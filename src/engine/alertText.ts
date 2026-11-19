import { formatSymbolPrice, type ConfluenceAlert } from './types.ts';

export interface AlertNotification {
  title: string;
  body: string;
  /** Stable per alert: duplicate notifications for the same setup replace instead of stacking. */
  tag: string;
}

/** Short title/body for a phone notification (shared by FCM push and on-device notifications). */
export function buildAlertNotification(alert: ConfluenceAlert, reminderNumber = 1): AlertNotification {
  // Persisted alerts and older fixtures may lack a price field. Never let a
  // missing optional price crash the entire notification pipeline.
  const fmt = (p: number | null | undefined) =>
    typeof p === 'number' && Number.isFinite(p) ? formatSymbolPrice(p, alert.symbol) : '—';
  // Older persisted/test alerts may not yet contain the new sweepPrice/stopLoss fields.
  const stopLoss = alert.stopLoss ?? alert.kzSweep?.sweepPrice ?? alert.kzSweep?.level;
  const bullish = alert.direction === 'BULLISH';
  const arrow = bullish ? '\u25B2' : '\u25BC';
  const dir = bullish ? 'HAUSSIER' : 'BAISSIER';
  const star = alert.probability === 'HIGH' ? ' \u2605 HAUTE PROBA' : '';
  const sweeps = alert.kzSweeps?.length ? alert.kzSweeps : [alert.kzSweep];
  const level = sweeps.map((sw) => `${sw.shortName}.${sw.isHigh ? 'H' : 'L'}`).join(' + ');
  const timeframe = alert.timeframe ?? 'M3';
  const prefix = reminderNumber > 1 ? `Rappel #${reminderNumber} \u00B7 ` : '';

  return {
    title: `${prefix}${arrow} ${alert.symbol} ${timeframe} \u00B7 ${dir}${star}`,
    body:
      `${alert.activeKillzoneName ?? 'Hors killzone'} \u00B7 balayages ${level} ` +
      `\u00B7 prix ${fmt(alert.cisd?.closePrice)} \u00B7 SL ${fmt(stopLoss)}`,
    tag: alert.dedupeKey.replace(/[^a-zA-Z0-9_-]/g, '_'),
  };
}
