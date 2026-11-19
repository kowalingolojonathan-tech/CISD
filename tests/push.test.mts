import crypto from 'node:crypto';
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const sa = {
  client_email: 'svc@demo.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  project_id: 'demo-proj',
};
process.env.FCM_SERVICE_ACCOUNT_BASE64 = Buffer.from(JSON.stringify(sa)).toString('base64');

const checks: string[] = [];
const ok = (c: boolean, m: string) => { checks.push(`${c ? 'PASS' : 'FAIL'}  ${m}`); if (!c) process.exitCode = 1; };

let oauthCalls = 0; const fcmBodies: any[] = [];
globalThis.fetch = (async (url: any, init: any) => {
  const u = String(url);
  if (u.includes('oauth2.googleapis.com')) {
    oauthCalls++;
    const jwt = new URLSearchParams(String(init.body)).get('assertion')!;
    const [h, c, sig] = jwt.split('.');
    const verified = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${c}`), publicKey, Buffer.from(sig, 'base64url'));
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    ok(verified, 'JWT signature verifies with the public key');
    ok(claims.iss === sa.client_email && claims.scope.includes('firebase.messaging'), 'JWT claims iss/scope');
    return new Response(JSON.stringify({ access_token: 'AT123', expires_in: 3600 }), { status: 200 });
  }
  if (u.includes('fcm.googleapis.com/v1/projects/demo-proj/messages:send')) {
    const body = JSON.parse(String(init.body)); fcmBodies.push(body);
    if (init.headers.Authorization !== 'Bearer AT123') return new Response('{}', { status: 401 });
    if (body.message.token.startsWith('dead')) {
      return new Response(JSON.stringify({ error: { status: 'NOT_FOUND', message: 'x', details: [{ errorCode: 'UNREGISTERED' }] } }), { status: 404 });
    }
    return new Response(JSON.stringify({ name: 'projects/demo-proj/messages/1' }), { status: 200 });
  }
  throw new Error('unexpected fetch ' + u);
}) as any;

const push = await import('../src/engine/push.ts');
push.initPushStore((await import('node:os')).tmpdir() + '/cisd-test-tokens.json');
ok(push.isPushConfigured(), 'service account loaded from base64 env');
ok(!push.getPushStore().add('short'), 'too-short token rejected');
push.getPushStore().add('good_token_' + 'a'.repeat(30));
push.getPushStore().add('dead_token_' + 'b'.repeat(30));

const r = await push.sendPushTest();
ok(r.sent === 1 && r.removed === 1, `test push: 1 sent, 1 dead token removed (${r.detail})`);
ok(push.getPushStore().count() === 1, 'dead token purged from store');
ok(oauthCalls === 1, 'single OAuth call for 2 devices');
const m = fcmBodies[0].message;
ok(m.android.priority === 'HIGH' && m.android.notification.channel_id === 'signals', 'HIGH priority + channel "signals"');

// second broadcast reuses cached access token
await push.sendPushTest();
ok(oauthCalls === 1, 'access token cached between sends');

// alert message formatting
const alert: any = { dedupeKey: 'lvl_12_BEARISH', id: 'conf_1', symbol: 'XAU/USD', timeframe: 'M5', direction: 'BEARISH', probability: 'HIGH',
  activeKillzoneName: 'NY AM', stopLoss: 4015.2, kzSweep: { id: 'sw1', shortName: 'L', isHigh: true, sessionName: 'London', level: 4012.5 },
  kzSweeps: [
    { id: 'sw1', shortName: 'L', isHigh: true, sessionName: 'London', level: 4012.5 },
    { id: 'sw2', shortName: 'N', isHigh: true, sessionName: 'NY AM', level: 4015.0 },
  ], cisd: { closePrice: 4010.2 } };
const pm = push.buildAlertPushMessage(alert, 3);
ok(pm.title.includes('Rappel #3') && pm.title.includes('BAISSIER') && pm.title.includes('HAUTE PROBA') && pm.title.includes('M5'), 'title includes timeframe: ' + pm.title);
ok(pm.body.includes('L.H + N.H'), 'notification body lists both swept session levels: ' + pm.body);
ok(pm.body.includes('SL 4015.20'), 'notification body includes the calculated stop loss: ' + pm.body);
ok(pm.tag === 'lvl_12_BEARISH', 'stable tag so reminders replace each other');
const legacyAlert: any = { ...alert, stopLoss: undefined, cisd: { ...alert.cisd, closePrice: undefined }, kzSweep: { ...alert.kzSweep, sweepPrice: undefined, level: undefined } };
const legacyPm = push.buildAlertPushMessage(legacyAlert, 1);
ok(legacyPm.body.includes('prix —') && legacyPm.body.includes('SL —'), 'missing legacy prices do not crash notification formatting');
console.log(checks.join('\n'));
