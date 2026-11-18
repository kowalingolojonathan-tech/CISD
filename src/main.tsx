import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';
import {installApiRuntime, needsServerSetup, showSetup} from './lib/runtime.ts';
import {initNativePush} from './lib/nativePush.ts';

installApiRuntime();

if (needsServerSetup()) {
  // APK first launch: ask for the server address before starting the app.
  showSetup('Renseignez l\u2019adresse de votre serveur Killzone CISD Desk.');
} else {
  createRoot(document.getElementById('root')!).render(<App />);
  void initNativePush().catch((err) => console.error('[push] init failed', err));
}
