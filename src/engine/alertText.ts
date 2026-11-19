import { formatSymbolPrice, type ConfluenceAlert } from './types.ts';

export interface AlertNotification {
  title: string;
  body: string;
  /** Stable per alert: reminders replace the previous notification instead of stacking. */
  tag: string;
}

/** Short title/body for a phone notification (shared by FCM push and on-device notifications). */
export function buildAlertNotification(alert: ConfluenceAlert, reminderNumber = 1): AlertNotification {
  const fmt = (p: number) => formatSymbolPrice(p, alert.symbol);
  const bullish = alert.direction === 'BULLISH';
  const arrow = bullish ? '\u25B2' : '\u25BC';
  const dir = bullish ? 'HAUSSIER' : 'BAISSIER';
  const star = alert.probability === 'HIGH' ? ' \u2605 HAUTE PROBA' : '';
  const level = `${alert.kzSweep.shortName}.${alert.kzSweep.isHigh ? 'H' : 'L'}`;
  const prefix = reminderNumber > 1 ? `Rappel #${reminderNumber} \u00B7 ` : '';

  return {
    title: `${prefix}${arrow} ${alert.symbol} \u00B7 ${dir}${star}`,
    body:
      `${alert.activeKillzoneName ?? 'Hors killzone'} \u00B7 cassure ${alert.kzSweep.sessionName} ${level} ` +
      `@ ${fmt(alert.kzSweep.level)} \u00B7 prix ${fmt(alert.cisd.closePrice)}`,
    tag: alert.dedupeKey.replace(/[^a-zA-Z0-9_-]/g, '_'),
  };
}
