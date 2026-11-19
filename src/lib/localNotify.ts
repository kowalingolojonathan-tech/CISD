import { Capacitor } from '@capacitor/core';
import { buildAlertNotification } from '../engine/alertText.ts';
import type { ConfluenceAlert } from '../engine/types.ts';

/** On-device notifications (no Firebase, no server): fired by the local engine. */

let ready: Promise<boolean> | null = null;
let actionListenerReady = false;

async function setup(): Promise<boolean> {
  const { LocalNotifications } = await import('@capacitor/local-notifications');

  let perm = await LocalNotifications.checkPermissions();
  if (perm.display === 'prompt' || perm.display === 'prompt-with-rationale') {
    perm = await LocalNotifications.requestPermissions();
  }
  if (perm.display !== 'granted') return false;

  // High importance: heads-up banner + sound + vibration, also on the lock screen.
  await LocalNotifications.registerActionTypes({
    types: [{
      id: 'CHOCH_ALERT_ACTIONS',
      actions: [{ id: 'acknowledge', title: "J'ai vu · arrêter les rappels", foreground: true }],
    }],
  });
  if (!actionListenerReady) {
    actionListenerReady = true;
    await LocalNotifications.addListener('localNotificationActionPerformed', async (event) => {
      if (event.actionId !== 'acknowledge') return;
      const extra = event.notification.extra as { id?: string; symbol?: string } | undefined;
      if (!extra?.id || !extra.symbol) return;
      try {
        await fetch(`/api/alerts/ack?symbol=${encodeURIComponent(extra.symbol)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: extra.id, symbol: extra.symbol }),
        });
      } catch (err) {
        console.error('[notify] acknowledgement failed', err);
      }
    });
  }

  await LocalNotifications.createChannel({
    id: 'signals',
    name: 'Signaux CHoCH',
    description: 'Alertes confluence Killzone + CHoCH',
    importance: 5,
    visibility: 1,
    vibration: true,
    lights: true,
  });
  return true;
}

export function initLocalNotifications(): Promise<boolean> {
  if (!Capacitor.isNativePlatform()) return Promise.resolve(false);
  ready ??= setup().catch((err) => {
    console.error('[notify] setup failed', err);
    return false;
  });
  return ready;
}

/** Stable positive int32 id per alert: reminders replace the previous notification. */
function notificationId(tag: string): number {
  let h = 0;
  for (let i = 0; i < tag.length; i++) h = (h * 31 + tag.charCodeAt(i)) | 0;
  return (Math.abs(h) % 2_000_000_000) + 1;
}

async function show(id: number, title: string, body: string, extra?: { id?: string; symbol?: string }): Promise<void> {
  const { LocalNotifications } = await import('@capacitor/local-notifications');
  await LocalNotifications.schedule({
    notifications: [{ id, title, body, channelId: 'signals', actionTypeId: extra?.id ? 'CHOCH_ALERT_ACTIONS' : undefined, extra }],
  });
}

export async function notifyAlertLocal(alert: ConfluenceAlert, reminderNumber: number): Promise<void> {
  if (!(await initLocalNotifications())) return;
  const n = buildAlertNotification(alert, reminderNumber);
  try {
    await show(notificationId(n.tag), n.title, `${n.body} · Appuyez sur « J'ai vu » pour arrêter les rappels.`, { id: alert.id, symbol: alert.symbol });
  } catch (err) {
    console.error('[notify] schedule failed', err);
  }
}

export async function testLocalNotification(): Promise<string> {
  if (!Capacitor.isNativePlatform()) return 'Notification locale indisponible (navigateur)';
  if (!(await initLocalNotifications())) return 'Notification locale refusee (autorisation manquante)';
  try {
    await show(notificationId('choch_test'), 'Killzone CHoCH Desk · Test', 'Les notifications locales fonctionnent.');
    return 'Notification locale envoyee';
  } catch (err) {
    return `Notification locale en erreur: ${err instanceof Error ? err.message : String(err)}`;
  }
}
