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

// ---- hub wires the alert hook (what triggers the on-device notification) ----
Date.now = () => Date.UTC(2026, 10, 17, 14, 30, 0);
const M3 = 180_000; const t0 = (h: number, m: number) => Date.UTC(2026, 10, 17, h, m);
const bars: Candle[] = [];
const push = (time: number, o: number, h: number, l: number, c: number) => bars.push({ time, open: o, high: h, low: l, close: c, volume: 0, confirmed: true });
for (let ts = t0(5, 0); ts < t0(14, 12); ts += M3) {
  const base = 1.0900 + ((ts / M3) % 7) * 0.0001; const up = (ts / M3) % 2 === 0;
  const spike = new Date(ts).getUTCHours() === 8 && new Date(ts).getUTCMinutes() === 30;
  push(ts, up ? base : base + 0.0003, Math.max(base, base + 0.0003) + (spike ? 0.0047 : 0.0002), Math.min(base, base + 0.0003) - 0.0002, up ? base + 0.0003 : base);
}
push(t0(14, 12), 1.0905, 1.0931, 1.0904, 1.0930); push(t0(14, 15), 1.0930, 1.0931, 1.0924, 1.0925);
push(t0(14, 18), 1.0925, 1.0926, 1.0919, 1.0920); push(t0(14, 21), 1.0920, 1.0958, 1.0919, 1.0954);

const fired: Array<[string, number]> = [];
saved = {}; const hub4 = createLocalHub((a, n) => fired.push([a.symbol, n]), memory);
hub4.engines['EUR/USD'].loadHistory(bars, null);
await hub4.engines['EUR/USD'].ingestLiveBar({ time: t0(14, 24), open: 1.0954, high: 1.0955, low: 1.0913, close: 1.0915, volume: 0, confirmed: false }, false);
ok(fired.length === 1 && fired[0][0] === 'EUR/USD' && fired[0][1] === 1, 'live signal calls the on-device notification hook exactly once');
console.log(checks.join('\n'));
process.exit(process.exitCode ?? 0);
