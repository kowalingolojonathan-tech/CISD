import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import {installApiRuntime, isLocalMode, isNativeApp, needsServerSetup, showSetup} from './lib/runtime.ts';

async function bootstrap() {
  await installApiRuntime();

  if (needsServerSetup()) {
    showSetup('Renseignez l\u2019adresse de votre serveur Killzone CISD Desk.');
    return;
  }

  createRoot(document.getElementById('root')!).render(<App />);

  if (!isNativeApp()) return;

  if (isLocalMode()) {
    // Autonomous mode: on-device notifications + foreground service so the engine keeps running.
    const {initLocalNotifications} = await import('./lib/localNotify.ts');
    const {startKeepAlive, askBatteryExemptionOnce} = await import('./lib/keepAlive.ts');
    await initLocalNotifications();
    await startKeepAlive();
    void askBatteryExemptionOnce();
  } else {
    // Server mode: Firebase push (only when the APK was built with a Firebase config).
    const {initNativePush} = await import('./lib/nativePush.ts');
    await initNativePush();
  }
}

bootstrap().catch((err) => console.error('[boot] failed', err));
