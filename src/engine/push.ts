import crypto from 'node:crypto';
import fs from 'node:fs';
import { buildAlertNotification } from './alertText.ts';
import type { ConfluenceAlert } from './types.ts';

/**
 * Native push (Firebase Cloud Messaging HTTP v1) for the Android APK.
 *
 * Needs one env var (service account of your Firebase project):
 *   FCM_SERVICE_ACCOUNT_BASE64  = base64 of the service-account JSON   (recommended)
 *   FCM_SERVICE_ACCOUNT_JSON    = the raw JSON                         (alternative)
 *
 * No SDK: the OAuth token is a JWT signed with node:crypto.
 */

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const TIMEOUT_MS = 8000;
const MAX_TOKENS = 20;
export const ANDROID_CHANNEL_ID = 'signals';

interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string;
  token_uri?: string;
}

export interface PushResult {
  configured: boolean;
  sent: number;
  failed: number;
  removed: number;
  detail: string;
}

function loadServiceAccount(): ServiceAccount | null {
  try {
    const raw = process.env.FCM_SERVICE_ACCOUNT_JSON?.trim();
    const b64 = process.env.FCM_SERVICE_ACCOUNT_BASE64?.trim();
    const text = raw || (b64 ? Buffer.from(b64, 'base64').toString('utf8') : '');
    if (!text) return null;
    const sa = JSON.parse(text) as Partial<ServiceAccount>;
    if (!sa.client_email || !sa.private_key || !sa.project_id) return null;
    return {
      client_email: sa.client_email,
      // tolerate keys pasted with literal "\n" sequences
      private_key: sa.private_key.replace(/\\n/g, '\n'),
      project_id: sa.project_id,
      token_uri: sa.token_uri,
    };
  } catch {
    return null;
  }
}

const serviceAccount = loadServiceAccount();

export function isPushConfigured(): boolean {
  return serviceAccount !== null;
}

/* ------------------------------ token storage ------------------------------ */

export class PushTokenStore {
  private tokens: string[] = [];

  constructor(private readonly filePath: string) {
    try {
      if (fs.existsSync(filePath)) {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { tokens?: unknown };
        if (Array.isArray(parsed.tokens)) {
          this.tokens = parsed.tokens.filter((t): t is string => typeof t === 'string');
        }
      }
    } catch {
      this.tokens = [];
    }
  }

  private persist() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify({ tokens: this.tokens }, null, 2), 'utf8');
    } catch {
      // Non-fatal: devices simply re-register at the next app launch
    }
  }

  public add(token: string): boolean {
    const clean = token.trim();
    if (clean.length < 20 || clean.length > 4096) return false;
    this.tokens = [clean, ...this.tokens.filter((t) => t !== clean)].slice(0, MAX_TOKENS);
    this.persist();
    return true;
  }

  public remove(token: string): boolean {
    const before = this.tokens.length;
    this.tokens = this.tokens.filter((t) => t !== token.trim());
    if (this.tokens.length !== before) this.persist();
    return this.tokens.length !== before;
  }

  public list(): string[] {
    return [...this.tokens];
  }

  public count(): number {
    return this.tokens.length;
  }
}

let store: PushTokenStore | null = null;

export function initPushStore(filePath: string): PushTokenStore {
  store = new PushTokenStore(filePath);
  return store;
}

export function getPushStore(): PushTokenStore {
  if (!store) store = new PushTokenStore('.push-tokens.json');
  return store;
}

/* --------------------------------- OAuth ---------------------------------- */

let cachedAccessToken: { value: string; expiresAt: number } | null = null;

const b64url = (input: string | Buffer) => Buffer.from(input).toString('base64url');

async function getAccessToken(sa: ServiceAccount): Promise<string> {
  if (cachedAccessToken && cachedAccessToken.expiresAt - 60_000 > Date.now()) {
    return cachedAccessToken.value;
  }

  const tokenUri = sa.token_uri || DEFAULT_TOKEN_URI;
  const nowSec = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: sa.client_email,
      scope: FCM_SCOPE,
      aud: tokenUri,
      iat: nowSec,
      exp: nowSec + 3600,
    })
  );
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(sa.private_key).toString('base64url');

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const json = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    expires_in?: number;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    throw new Error(`OAuth FCM: ${json.error_description ?? `HTTP ${res.status}`}`);
  }
  cachedAccessToken = {
    value: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
  };
  return json.access_token;
}

/* -------------------------------- sending --------------------------------- */

interface PushMessage {
  title: string;
  body: string;
  tag?: string;
  data?: Record<string, string>;
}

type SendOutcome = 'sent' | 'failed' | 'invalid_token';

async function sendToToken(
  sa: ServiceAccount,
  accessToken: string,
  deviceToken: string,
  msg: PushMessage
): Promise<{ outcome: SendOutcome; error?: string }> {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: {
        token: deviceToken,
        notification: { title: msg.title, body: msg.body },
        data: msg.data ?? {},
        android: {
          // HIGH priority wakes the device from Doze: this is what makes it instant.
          priority: 'HIGH',
          ttl: '120s',
          notification: {
            channel_id: ANDROID_CHANNEL_ID,
            tag: msg.tag,
            sound: 'default',
            default_vibrate_timings: true,
            notification_priority: 'PRIORITY_MAX',
            visibility: 'PUBLIC',
          },
        },
      },
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (res.ok) return { outcome: 'sent' };

  const err = (await res.json().catch(() => ({}))) as {
    error?: { status?: string; message?: string; details?: Array<{ errorCode?: string }> };
  };
  const status = err.error?.status ?? '';
  const code = err.error?.details?.find((d) => d.errorCode)?.errorCode ?? '';
  const message = err.error?.message ?? `HTTP ${res.status}`;

  const tokenIsDead =
    code === 'UNREGISTERED' ||
    status === 'NOT_FOUND' ||
    (status === 'INVALID_ARGUMENT' && /registration token/i.test(message));

  return { outcome: tokenIsDead ? 'invalid_token' : 'failed', error: message };
}

async function broadcast(msg: PushMessage): Promise<PushResult> {
  if (!serviceAccount) {
    return {
      configured: false,
      sent: 0,
      failed: 0,
      removed: 0,
      detail: 'Push non configure (FCM_SERVICE_ACCOUNT_BASE64 manquant)',
    };
  }

  const devices = getPushStore().list();
  if (devices.length === 0) {
    return {
      configured: true,
      sent: 0,
      failed: 0,
      removed: 0,
      detail: 'Aucun appareil enregistre (ouvrez l\u2019APK une fois)',
    };
  }

  try {
    const accessToken = await getAccessToken(serviceAccount);
    const outcomes = await Promise.all(
      devices.map((t) =>
        sendToToken(serviceAccount, accessToken, t, msg).catch((e: unknown) => ({
          outcome: 'failed' as SendOutcome,
          error: e instanceof Error ? e.message : String(e),
        }))
      )
    );

    let sent = 0;
    let failed = 0;
    let removed = 0;
    const errors: string[] = [];
    outcomes.forEach((o, i) => {
      if (o.outcome === 'sent') sent++;
      else {
        failed++;
        if (o.error) errors.push(o.error);
        if (o.outcome === 'invalid_token' && getPushStore().remove(devices[i])) removed++;
      }
    });

    return {
      configured: true,
      sent,
      failed,
      removed,
      detail:
        `Push ${sent}/${devices.length} OK` +
        (removed ? `, ${removed} appareil(s) obsolete(s) retire(s)` : '') +
        (errors.length ? ` — ${errors[0]}` : ''),
    };
  } catch (err) {
    return {
      configured: true,
      sent: 0,
      failed: devices.length,
      removed: 0,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/* ------------------------------ public helpers ----------------------------- */

export function buildAlertPushMessage(alert: ConfluenceAlert, reminderNumber = 1): PushMessage {
  const n = buildAlertNotification(alert, reminderNumber);
  return {
    title: n.title,
    body: n.body,
    tag: n.tag,
    data: {
      type: 'confluence',
      alertId: alert.id,
      symbol: alert.symbol,
      direction: alert.direction,
      probability: alert.probability,
      reminder: String(reminderNumber),
    },
  };
}

export function sendPushForAlert(alert: ConfluenceAlert, reminderNumber = 1): Promise<PushResult> {
  return broadcast(buildAlertPushMessage(alert, reminderNumber));
}

export function sendPushTest(): Promise<PushResult> {
  return broadcast({
    title: 'Killzone CISD Desk \u00B7 Test',
    body: 'Les notifications push fonctionnent.',
    tag: 'cisd_test',
    data: { type: 'test' },
  });
}
