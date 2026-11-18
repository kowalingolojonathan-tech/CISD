/**
 * Runtime glue so the SAME web app works in a browser (same-origin) and inside the
 * Android APK (bundled assets talking to a remote server).
 *
 *  - prefixes every `/api/...` fetch / EventSource with the configured server URL
 *  - sends the optional access token (header for fetch, ?token= for EventSource)
 *  - shows a small setup screen when the server URL or token is missing/wrong
 */

const LS_URL = 'cisd_server_url';
const LS_TOKEN = 'cisd_access_token';

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

export function getServerBase(): string {
  const stored = safeGet(LS_URL);
  const baked = (import.meta.env.VITE_SERVER_URL as string | undefined) ?? '';
  return (stored || baked || '').trim().replace(/\/+$/, '');
}

export function getAccessToken(): string {
  return safeGet(LS_TOKEN).trim();
}

/** In the APK there is no "same origin": a server URL is mandatory. */
export function needsServerSetup(): boolean {
  return isNativeApp() && getServerBase() === '';
}

function withBase(url: string): string {
  return url.startsWith('/api/') ? getServerBase() + url : url;
}

function withTokenQuery(url: string): string {
  const token = getAccessToken();
  if (!token || !url.includes('/api/')) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
}

export function installApiRuntime(): void {
  const originalFetch = window.fetch.bind(window);

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

export function showSetup(reason?: string): void {
  if (document.getElementById('cisd-setup')) return;

  const wrap = document.createElement('div');
  wrap.id = 'cisd-setup';
  wrap.style.cssText =
    'position:fixed;inset:0;z-index:99999;background:#0B0F17;color:#F1F5F9;display:flex;' +
    'align-items:center;justify-content:center;padding:24px;font-family:system-ui,sans-serif';

  const card = document.createElement('div');
  card.style.cssText = 'width:100%;max-width:420px;display:flex;flex-direction:column;gap:12px';

  const h = document.createElement('h1');
  h.textContent = 'Killzone CISD Desk';
  h.style.cssText = 'font-size:20px;font-weight:700;margin:0';

  const p = document.createElement('p');
  p.textContent = reason ?? 'Renseignez l\u2019adresse de votre serveur.';
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

  const url = field('Adresse du serveur', getServerBase(), 'https://mon-serveur.example.com');
  const token = field('Jeton d\u2019acc\u00e8s (si ACCESS_TOKEN est d\u00e9fini)', getAccessToken(), 'optionnel', 'password');

  const save = document.createElement('button');
  save.textContent = 'Enregistrer et relancer';
  save.style.cssText =
    'padding:12px;border-radius:8px;border:0;background:#2563EB;color:#fff;font-size:15px;font-weight:600';
  save.onclick = () => {
    const cleaned = url.i.value.trim().replace(/\/+$/, '');
    if (isNativeApp() && !/^https?:\/\//i.test(cleaned)) {
      p.textContent = 'L\u2019adresse doit commencer par http:// ou https://';
      p.style.color = '#F87171';
      return;
    }
    try {
      localStorage.setItem(LS_URL, cleaned);
      localStorage.setItem(LS_TOKEN, token.i.value.trim());
    } catch {
      // storage unavailable: nothing more we can do
    }
    window.location.reload();
  };

  card.append(h, p, url.l, token.l, save);
  wrap.appendChild(card);
  document.body.appendChild(wrap);
}

function addSettingsButton(): void {
  const btn = document.createElement('button');
  btn.textContent = '\u2699';
  btn.setAttribute('aria-label', 'Serveur');
  btn.style.cssText =
    'position:fixed;left:8px;bottom:8px;z-index:9999;width:36px;height:36px;border-radius:18px;border:0;' +
    'background:rgba(30,41,59,.7);color:#CBD5E1;font-size:18px';
  btn.onclick = () => showSetup('Modifier le serveur ou le jeton.');
  document.body.appendChild(btn);
}
