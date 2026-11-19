import { EngineHub, resolveSymbol, type HubStorage, type PersistedConfigFile } from '../engine/hub.ts';
import type { ConfluenceAlert, EngineConfig } from '../engine/types.ts';

/**
 * On-device mode: the engine runs inside the app (no server). This file answers the same
 * `/api/...` calls and the same real-time stream the UI already uses, from the local hub.
 */

const STORAGE_KEY = 'cisd_runtime_config';

export const localStorageBackend: HubStorage = {
  load(): PersistedConfigFile {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? (JSON.parse(raw) as PersistedConfigFile) : {};
    } catch {
      return {};
    }
  },
  save(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // storage full/unavailable: settings simply won't persist
    }
  },
};

export function createLocalHub(
  onAlert?: (alert: ConfluenceAlert, reminderNumber: number) => void,
  storage: HubStorage = localStorageBackend
): EngineHub {
  return new EngineHub({ storage, onAlert });
}

export interface LocalApiOptions {
  /** Extra on-device test (e.g. a local notification); its text is appended to the test result. */
  onTestNotification?: () => Promise<string>;
}

export interface LocalApi {
  fetch(input: string, init?: RequestInit): Promise<Response>;
  EventSourceClass: typeof EventSource;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function createLocalApi(hub: EngineHub, options: LocalApiOptions = {}): LocalApi {
  async function handle(input: string, init?: RequestInit): Promise<Response> {
    const url = new URL(input, 'http://local');
    const method = (init?.method ?? 'GET').toUpperCase();
    const symParam = url.searchParams.get('symbol');

    let body: Record<string, unknown> = {};
    if (typeof init?.body === 'string' && init.body) {
      try {
        body = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        body = {};
      }
    }

    try {
      switch (`${method} ${url.pathname}`) {
        case 'GET /api/health':
          return json({
            ok: true,
            mode: 'local',
            symbols: ['XAU/USD', 'EUR/USD'],
            overview: hub.getSymbolsOverview(),
          });

        case 'GET /api/state':
          return json(hub.buildSnapshot(resolveSymbol(symParam)));

        case 'POST /api/alerts/ack': {
          const result = hub.acknowledge(resolveSymbol(symParam ?? body.symbol), body);
          return json(result, result.ok ? 200 : 400);
        }

        case 'POST /api/config': {
          const sym = resolveSymbol(symParam ?? body.symbol);
          return json({ ok: true, snapshot: await hub.updateConfig(sym, body as Partial<EngineConfig>) });
        }

        case 'POST /api/feed/refresh':
          return json({ ok: true, snapshot: await hub.refreshFeed(resolveSymbol(symParam)) });

        case 'POST /api/webhook/test': {
          const result = await hub.testWebhook(resolveSymbol(symParam));
          const localDetail = options.onTestNotification ? await options.onTestNotification() : '';
          return json({
            ...result,
            ok: result.ok || localDetail.startsWith('Notification locale envoyee'),
            detail: localDetail ? `${result.detail} | ${localDetail}` : result.detail,
          });
        }

        case 'GET /api/push/status':
          return json({ ok: true, configured: false, devices: 0 });

        default:
          return json({ ok: false, error: `Route locale inconnue: ${method} ${url.pathname}` }, 404);
      }
    } catch (err) {
      return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 400);
    }
  }

  /** Minimal EventSource look-alike fed directly by the hub (UI uses onmessage + close only). */
  class LocalEventSource extends EventTarget {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSED = 2;
    readonly CONNECTING = 0;
    readonly OPEN = 1;
    readonly CLOSED = 2;

    public onopen: ((ev: Event) => void) | null = null;
    public onmessage: ((ev: MessageEvent) => void) | null = null;
    public onerror: ((ev: Event) => void) | null = null;
    public readyState = 0;
    public readonly url: string;
    public readonly withCredentials = false;

    private unsubscribe: (() => void) | null = null;

    constructor(url: string | URL) {
      super();
      this.url = String(url);
      const sym = resolveSymbol(new URL(this.url, 'http://local').searchParams.get('symbol'));

      // Deferred so the caller can attach `onmessage` before the first frame is delivered.
      setTimeout(() => {
        if (this.readyState === 2) return;
        this.readyState = 1;
        const open = new Event('open');
        this.dispatchEvent(open);
        this.onopen?.(open);
        this.unsubscribe = hub.subscribe(sym, (snapshot) => {
          if (this.readyState !== 1) return;
          const ev = new MessageEvent('message', { data: JSON.stringify(snapshot) });
          this.dispatchEvent(ev);
          this.onmessage?.(ev);
        });
      }, 0);
    }

    close() {
      this.readyState = 2;
      this.unsubscribe?.();
      this.unsubscribe = null;
    }
  }

  return {
    fetch: handle,
    EventSourceClass: LocalEventSource as unknown as typeof EventSource,
  };
}
