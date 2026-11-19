import { createLocalApi, createLocalHub } from '../src/lib/localApi.ts';
import type { HubStorage, PersistedConfigFile } from '../src/engine/hub.ts';
import type { Candle } from '../src/engine/types.ts';

const checks: string[] = [];
const ok = (c: boolean, m: string) => { checks.push(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let saved: PersistedConfigFile = {};
const memory: HubStorage = { load: () => saved, save: (d) => { saved = JSON.parse(JSON.stringify(d)); } };

const hub = createLocalHub(undefined, memory);
const api = createLocalApi(hub, { onTestNotification: async () => 'Notification locale envoyee' });
const post = (path: string, body: unknown) => api.fetch(path, { method: 'POST', body: JSON.stringify(body) });

// ---- REST routes the UI relies on ----
let res = await api.fetch('/api/state?symbol=EUR%2FUSD');
let snap: any = await res.json();
ok(res.status === 200 && snap.config.symbol === 'EUR/USD' && snap.symbolsOverview.length === 2, 'GET /api/state returns the EUR/USD snapshot with both overviews');
ok(!('telegramBotToken' in snap.config), 'snapshot never exposes the Telegram token');

res = await post('/api/config?symbol=XAU%2FUSD', { tolerance: 0.5, telegramChatId: ' 123 ', telegramBotToken: 'abc:def' });
snap = (await res.json()).snapshot;
ok(res.status === 200 && snap.config.tolerance === 0.5 && snap.config.telegramChatId === '123' && snap.config.hasTelegramToken, 'POST /api/config applies and trims settings');
ok(saved.tolerance === 0.5 && saved.telegramBotToken === 'abc:def', 'settings persisted through the storage backend');

await post('/api/config', { tolerance: 5, swingPeriod: 999 });
ok(hub.engines['XAU/USD'].getConfig().tolerance === 0.5 && hub.engines['XAU/USD'].getConfig().swingPeriod === 12, 'out-of-range values are rejected');

const hub2 = createLocalHub(undefined, memory);
ok(hub2.engines['EUR/USD'].getConfig().tolerance === 0.5 && hub2.engines['EUR/USD'].getConfig().telegramBotToken === 'abc:def', 'a restarted hub reloads the saved settings');

res = await post('/api/alerts/ack', {});
ok(res.status === 400, 'ack without id -> 400');
res = await post('/api/alerts/ack', { all: true });
ok(res.status === 200 && (await res.json()).acknowledgedCount === 0, 'ack all with nothing pending -> 0');

res = await api.fetch('/api/nope');
ok(res.status === 404, 'unknown route -> 404');

// the test button runs the Telegram/webhook test AND the on-device notification
saved = {}; const hub3 = createLocalHub(undefined, memory);
const api3 = createLocalApi(hub3, { onTestNotification: async () => 'Notification locale envoyee' });
const t = await (await api3.fetch('/api/webhook/test?symbol=XAU%2FUSD', { method: 'POST' })).json() as any;
ok(t.ok === true && t.detail.includes('Notification locale envoyee'), `test button reports the local notification (${t.detail})`);

// ---- real-time stream (EventSource look-alike) ----
const es = new api.EventSourceClass('/api/stream?symbol=XAU%2FUSD');
const frames: any[] = [];
es.onmessage = (ev) => frames.push(JSON.parse(ev.data));
await sleep(20);
ok(frames.length >= 1 && frames[0].config.symbol === 'XAU/USD', 'first frame delivered after onmessage is attached');
const before = frames.length;
hub.engines['XAU/USD'].setFeedStatus(true, Date.now(), null);
ok(frames.length > before, 'engine updates are pushed to the stream');
es.close();
const afterClose = frames.length;
hub.engines['XAU/USD'].setFeedStatus(true, Date.now(), null);
ok(frames.length === afterClose && es.readyState === 2, 'no frames after close()');

// ---- hub wires the alert hook for a valid M3 CHoCH alert ----
Date.now = () => Date.UTC(2026, 10, 17, 14, 30, 0);
const now = Date.now();
const fired: Array<[string, number]> = [];
saved = {}; const hub4 = createLocalHub((a, n) => fired.push([a.symbol, n]), memory);
const engine = hub4.engines['EUR/USD'] as any;
const sweep = { id: 'sw_live', levelId: 'lvl_live', sessionId: 'london', sessionName: 'London', shortName: 'L', isHigh: true, level: 1.0950, createdAt: now - 60 * 60_000, sweptAt: now - 60_000, sweptBarIndex: 1, sweepPrice: 1.0960 };
engine.kzEngine.getSweepEvents = () => [sweep];
const alert = engine.evaluateConfluence(
  { time: now, open: 1.0960, high: 1.0962, low: 1.0940, close: 1.0955, confirmed: true },
  3,
  { id: 'choch_live', barIndex: 3, time: now, direction: 'bearish', originLevel: 1.0940, originBarIndex: 2, noiseRatio: 0, toleranceUsed: 0, strongSweep: false, wickedSwingLevel: null, barsSinceSwing: null, closePrice: 1.0955 },
  sweep, null, true, 'M3'
);
await engine.recordAndDispatchAlert(alert, true);
ok(fired.length === 1 && fired[0][0] === 'EUR/USD' && fired[0][1] === 1, 'valid live CHoCH calls the on-device notification hook exactly once');
console.log(checks.join('\n'));
process.exit(process.exitCode ?? 0);
