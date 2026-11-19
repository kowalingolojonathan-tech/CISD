import { Capacitor } from '@capacitor/core';

/**
 * Registers this phone for native push (Firebase Cloud Messaging) and sends the device
 * token to the server. Only runs inside the Android APK, and only when the APK was built
 * with a Firebase config (VITE_PUSH_ENABLED=true) — registering without it would crash the app.
 */
export async function initNativePush(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  if (import.meta.env.VITE_PUSH_ENABLED !== 'true') return;

  const { PushNotifications } = await import('@capacitor/push-notifications');

  let perm = await PushNotifications.checkPermissions();
  if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') {
    perm = await PushNotifications.requestPermissions();
  }
  if (perm.receive !== 'granted') {
    console.warn('[push] notification permission denied');
    return;
  }

  // High-importance channel: heads-up banner + sound + vibration, even on the lock screen.
  await PushNotifications.createChannel({
    id: 'signals',
    name: 'Signaux CHoCH',
    description: 'Alertes confluence Killzone + CHoCH',
    importance: 5,
    visibility: 1,
    vibration: true,
    lights: true,
  });

  await PushNotifications.addListener('registration', (token) => {
    void fetch('/api/push/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token.value, platform: 'android' }),
    }).catch((err) => console.error('[push] register failed', err));
  });

  await PushNotifications.addListener('registrationError', (err) => {
    console.error('[push] registration error', err);
  });

  await PushNotifications.register();
}
