import { Capacitor, registerPlugin } from '@capacitor/core';

/**
 * Android foreground service (persistent notification + partial wake lock) so the on-device
 * engine keeps running when the screen is off or the app is in the background.
 * The native side is generated in CI by scripts/patch-android.mjs.
 */
interface KeepAlivePlugin {
  start(): Promise<void>;
  stop(): Promise<void>;
  batteryStatus(): Promise<{ ignoring: boolean }>;
  requestBatteryExemption(): Promise<void>;
}

const KeepAlive = registerPlugin<KeepAlivePlugin>('KeepAlive');
const LS_BATTERY_ASKED = 'cisd_battery_asked';

export async function startKeepAlive(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await KeepAlive.start();
  } catch (err) {
    console.error('[keepalive] start failed', err);
  }
}

/** Asks (once) to be exempted from battery optimisation: Android otherwise throttles background apps. */
export async function askBatteryExemptionOnce(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    if (localStorage.getItem(LS_BATTERY_ASKED) === '1') return;
    const { ignoring } = await KeepAlive.batteryStatus();
    localStorage.setItem(LS_BATTERY_ASKED, '1');
    if (!ignoring) await KeepAlive.requestBatteryExemption();
  } catch (err) {
    console.error('[keepalive] battery request failed', err);
  }
}
