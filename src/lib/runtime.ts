/**
 * Runtime glue so the SAME web app works in three places:
 *  - browser, served by the Node server (same origin)             -> nothing to do
 *  - Android APK, "autonomous" mode (default): the engine runs ON the phone
 *  - Android APK, "server" mode: talks to a remote server (URL + optional token)
 */

const LS_URL = 'cisd_server_url';
const LS_TOKEN = 'cisd_access_token';
const LS_MODE = 'cisd_mode'; // 'local' | 'remote' (APK only)

type Mode = 'local' | 'remote';

export function isNativeApp(): boolean {
  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;
  return !!cap?.isNativePlatform?.();
}

function safeGet(key: string): string {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

function bakedServerUrl(): string {
  return ((import.meta.env.VITE_SERVER_URL as string | undefined) ?? '').trim().replace(/\/+$/, '');
}

/**
 * The mode must be chosen explicitly: an address stored by an older build never silently
 * forces server mode. Default = autonomous, unless the APK was built with a server URL.
 */
function getMode(): Mode {
  if (!isNativeApp()) return 'remote';
  const m = safeGet(LS_MODE);
  if (m === 'local' || m === 'remote') return m;
  return bakedServerUrl() ? 'remote' : 'local';
}

export function isLocalMode(): boolean {
  return isNativeApp() && getMode() === 'local';
}

export function getServerBase(): string {
  if (!isNativeApp() || getMode() !== 'remote') return '';
  return (safeGet(LS_URL) || bakedServerUrl()).trim().replace(/\/+$/, '');
}

export function getAccessToken(): string {
  return safeGet(LS_TOKEN).trim();
}

/** Server mode chosen but no address known yet. */
export function needsServerSetup(): boolean {
  return isNativeApp() && getMode() === 'remote' && getServerBase() === '';
}

function withBase(url: string): string {
  return url.startsWith('/api/') ? getServerBase() + url : url;
}

function withTokenQuery(url: string): string {
  const token = getAccessToken();
  if (!token || !url.includes('/api/')) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

/** Hooks fetch/EventSource. Resolves once the on-device engine (if any) is ready. */
export async function installApiRuntime(): Promise<void> {
  const originalFetch = window.fetch.bind(window);

  if (isLocalMode()) {
    const { createLocalHub, createLocalApi } = await import('./localApi.ts');
    const { notifyAlertLocal, testLocalNotification } = await import('./localNotify.ts');

    const hub = createLocalHub((alert, reminderNumber) => {
      void notifyAlertLocal(alert, reminderNumber);
    });
    const api = createLocalApi(hub, { onTestNotification: testLocalNotification });

    window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> =>
      typeof input === 'string' && input.startsWith('/api/')
        ? api.fetch(input, init)
        : originalFetch(input, init);
    window.EventSource = api.EventSourceClass;

    hub.start();
    addSettingsButton();
    return;
  }

  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (typeof input === 'string' && input.startsWith('/api/')) {
      const headers = new Headers(init?.headers);
      const token = getAccessToken();
      if (token) headers.set('x-access-token', token);
      return originalFetch(withBase(input), { ...init, headers }).then((res) => {
        if (res.status === 401) showSetup('Jeton d\u2019acc\u00e8s refus\u00e9 par le serveur.');
        return res;
      });
    }
    return originalFetch(input, init);
  };

  const OriginalEventSource = window.EventSource;
  class ApiEventSource extends OriginalEventSource {
    constructor(url: string | URL, init?: EventSourceInit) {
      const raw = typeof url === 'string' ? url : url.toString();
      super(withTokenQuery(withBase(raw)), init);
    }
  }
  window.EventSource = ApiEventSource as typeof EventSource;

  if (isNativeApp()) addSettingsButton();
}

/* ------------------------------ setup screen ------------------------------- */

function save(mode: Mode, url: string, token: string): void {
  try {
    localStorage.setItem(LS_MODE, mode);
    localStorage.setItem(LS_URL, url);
    localStorage.setItem(LS_TOKEN, token);
  } catch {
    // storage unavailable: nothing more we can do
  }
  window.location.reload();
}

export function showSetup(reason?: string): void {
  if (document.getElementById('cisd-setup')) return;

  const wrap = document.createElement('div');
  wrap.id = 'cisd-setup';
  wrap.style.cssText =
    'position:fixed;inset:0;z-index:99999;background:#0B0F17;color:#F1F5F9;display:flex;' +
    'align-items:center;justify-content:center;padding:24px;font-family:system-ui,sans-serif;overflow:auto';

  const card = document.createElement('div');
  card.style.cssText = 'width:100%;max-width:420px;display:flex;flex-direction:column;gap:12px';

  const h = document.createElement('h1');
  h.textContent = 'Killzone CISD Desk';
  h.style.cssText = 'font-size:20px;font-weight:700;margin:0';

  const p = document.createElement('p');
  p.textContent = reason ?? 'Choisissez comment utiliser l\u2019application.';
  p.style.cssText = 'margin:0;color:#94A3B8;font-size:14px';

  const field = (label: string, value: string, placeholder: string, type = 'text') => {
    const l = document.createElement('label');
    l.textContent = label;
    l.style.cssText = 'font-size:12px;color:#94A3B8;display:flex;flex-direction:column;gap:6px';
    const i = document.createElement('input');
    i.type = type;
    i.value = value;
    i.placeholder = placeholder;
    i.autocapitalize = 'off';
    i.autocomplete = 'off';
    i.spellcheck = false;
    i.style.cssText =
      'padding:12px;border-radius:8px;border:1px solid #334155;background:#111827;color:#F1F5F9;font-size:15px';
    l.appendChild(i);
    return { l, i };
  };

  const button = (text: string, primary: boolean) => {
    const b = document.createElement('button');
    b.textContent = text;
    b.style.cssText =
      'padding:12px;border-radius:8px;font-size:15px;font-weight:600;' +
      (primary
        ? 'border:0;background:#2563EB;color:#fff'
        : 'border:1px solid #334155;background:transparent;color:#CBD5E1');
    return b;
  };

  const local = button('Mode autonome (sans serveur)', true);
  local.onclick = () => save('local', '', '');

  const sep = document.createElement('p');
  sep.textContent = 'ou se connecter \u00e0 un serveur :';
  sep.style.cssText = 'margin:8px 0 0;color:#94A3B8;font-size:13px';

  const url = field('Adresse du serveur', safeGet(LS_URL), 'https://mon-serveur.example.com');
  const token = field('Jeton d\u2019acc\u00e8s (optionnel)', getAccessToken(), 'ACCESS_TOKEN', 'password');

  const remote = button('Utiliser ce serveur', false);
  remote.onclick = () => {
    const cleaned = url.i.value.trim().replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(cleaned)) {
      p.textContent = 'L\u2019adresse doit commencer par http:// ou https://';
      p.style.color = '#F87171';
      return;
    }
    save('remote', cleaned, token.i.value.trim());
  };

  const close = button('Annuler', false);
  close.onclick = () => wrap.remove();

  card.append(h, p, local, sep, url.l, token.l, remote, close);
  wrap.appendChild(card);
  document.body.appendChild(wrap);
}

function addSettingsButton(): void {
  const btn = document.createElement('button');
  btn.textContent = '\u2699';
  btn.setAttribute('aria-label', 'Mode / serveur');
  btn.style.cssText =
    'position:fixed;left:8px;bottom:8px;z-index:9999;width:36px;height:36px;border-radius:18px;border:0;' +
    'background:rgba(30,41,59,.7);color:#CBD5E1;font-size:18px';
  btn.onclick = () => showSetup('Changer de mode ou de serveur.');
  document.body.appendChild(btn);
}
