import { Capacitor } from '@capacitor/core';
import { buildAlertNotification } from '../engine/alertText.ts';
import type { ConfluenceAlert } from '../engine/types.ts';

/** On-device notifications (no Firebase, no server): fired by the local engine. */

let ready: Promise<boolean> | null = null;

async function setup(): Promise<boolean> {
  const { LocalNotifications } = await import('@capacitor/local-notifications');

  let perm = await LocalNotifications.checkPermissions();
  if (perm.display === 'prompt' || perm.display === 'prompt-with-rationale') {
    perm = await LocalNotifications.requestPermissions();
  }
  if (perm.display !== 'granted') return false;

  // High importance: heads-up banner + sound + vibration, also on the lock screen.
  await LocalNotifications.createChannel({
    id: 'signals',
    name: 'Signaux CISD',
    description: 'Alertes confluence Killzone + CISD',
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

async function show(id: number, title: string, body: string): Promise<void> {
  const { LocalNotifications } = await import('@capacitor/local-notifications');
  await LocalNotifications.schedule({
    notifications: [{ id, title, body, channelId: 'signals' }],
  });
}

export async function notifyAlertLocal(alert: ConfluenceAlert, reminderNumber: number): Promise<void> {
  if (!(await initLocalNotifications())) return;
  const n = buildAlertNotification(alert, reminderNumber);
  try {
    await show(notificationId(n.tag), n.title, n.body);
  } catch (err) {
    console.error('[notify] schedule failed', err);
  }
}

export async function testLocalNotification(): Promise<string> {
  if (!Capacitor.isNativePlatform()) return 'Notification locale indisponible (navigateur)';
  if (!(await initLocalNotifications())) return 'Notification locale refusee (autorisation manquante)';
  try {
    await show(notificationId('cisd_test'), 'Killzone CISD Desk · Test', 'Les notifications locales fonctionnent.');
    return 'Notification locale envoyee';
  } catch (err) {
    return `Notification locale en erreur: ${err instanceof Error ? err.message : String(err)}`;
  }
}
