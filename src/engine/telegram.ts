import { formatSymbolPrice, type ConfluenceAlert } from './types.ts';

const OUTBOUND_TIMEOUT_MS = 8000;

/** fetch() with a hard timeout so a stuck Telegram/webhook call can't block alerts or polling. */
function tgFetch(url: string, init: RequestInit = {}) {
  return fetch(url, { ...init, signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS) });
}

export interface WebhookDispatchResult {
  sent: boolean;
  status: 'sent' | 'skipped' | 'failed';
  detail: string;
  telegramMessageId?: number;
}

function biasFr(b: 'BULLISH' | 'BEARISH' | 'NEUTRAL'): string {
  return b === 'BULLISH' ? 'HAUSSIER' : b === 'BEARISH' ? 'BAISSIER' : 'NEUTRE';
}

export function formatTelegramMessage(alert: ConfluenceAlert, reminderNumber = 1): string {
  const fmt = (p: number) => formatSymbolPrice(p, alert.symbol);
  const dirLabel = alert.direction === 'BULLISH' ? 'RETOURNEMENT HAUSSIER' : 'RETOURNEMENT BAISSIER';
  const arrow = alert.direction === 'BULLISH' ? '▲' : '▼';
  const sweeps = alert.kzSweeps?.length ? alert.kzSweeps : [alert.kzSweep];
  const sweepLines = sweeps.map((sw) => `• ${sw.sessionName} (${sw.shortName}.${sw.isHigh ? 'H' : 'L'}) @ <code>${fmt(sw.level)}</code>`);
  const timeframe = alert.timeframe ?? 'M3';
  const phaseLabel = alert.isPreReentry
    ? 'AVANT REINTEGRATION (Prix encore hors niveau)'
    : 'REINTEGRATION CONFIRMEE';
  const timingLabel = alert.isIntrabarSignal ? `Temps reel (Intrabar ${timeframe})` : `Cloture ${timeframe} confirmee`;
  const sessionLabel = alert.activeKillzoneName ?? 'Hors Killzone';
  const probHeader =
    alert.probability === 'HIGH'
      ? `<b>★ PROBABILITE ELEVEE (Alignement Daily + H4) ★</b>\n`
      : alert.probability === 'MEDIUM'
      ? `<b>Probabilite Moyenne (1/2 HTF aligne)</b>\n`
      : `<b>Contre-Tendance HTF</b>\n`;
  const reminderBanner =
    reminderNumber > 1
      ? `<b>🔔 RAPPEL #${reminderNumber} — SIGNAL EN COURS NON VALIDE</b>\n<i>Cliquez sur "✅ J'ai vu" ci-dessous ou validez dans l'app pour marquer le signal comme vu.</i>\n\n`
      : `<b>🔴 SIGNAL EN COURS — VALIDATION REQUISE</b>\n`;
  const swingLine = alert.hasInternalSwingSweep
    ? `\n• <b>Swing Sweep AlgoAlpha :</b> Confirme (${
        alert.cisd.wickedSwingLevel !== null ? fmt(alert.cisd.wickedSwingLevel) : '-'
      })`
    : '';

  return [
    `${reminderBanner}${probHeader}<b>${arrow} SIGNAL CONFLUENCE — ${alert.symbol} ${timeframe}</b>`,
    `<b>Direction :</b> ${dirLabel}`,
    `<b>Biais HTF :</b> Daily <code>${biasFr(alert.dailyBias)}</code> · H4 <code>${biasFr(alert.h4Bias)}</code>`,
    `<b>Killzone Active :</b> ${sessionLabel}`,
    `<b>Niveaux balayes (${sweeps.length}) :</b>\n${sweepLines.join('\n')}`, 
    `<b>Prix Actuel / Sweep :</b> <code>${fmt(alert.cisd.closePrice)}</code> (Meche: <code>${fmt(alert.kzSweep.sweepPrice)}</code>)`,
    `<b>Stop Loss (extreme du sweep) :</b> <code>${fmt(alert.stopLoss ?? alert.kzSweep.sweepPrice)}</code>`,
    `<b>Position Prix :</b> ${phaseLabel}`,
    `<b>CISD ${timeframe} :</b> Origine <code>${fmt(alert.cisd.originLevel)}</code> · Ratio <code>${alert.cisd.noiseRatio.toFixed(2)}</code> (&gt; ${alert.cisd.toleranceUsed})`,
    `<b>Declenchement :</b> ${timingLabel} · Delai ${alert.barsBetweenSweepAndCisd} bougie(s) ${timeframe}${swingLine}`,
    `<b>Heure NY :</b> <code>${alert.nyTimeStr}</code>`,
  ].join('\n');
}

export async function dispatchAlertWebhook(
  alert: ConfluenceAlert,
  opts: {
    telegramBotToken: string;
    telegramChatId: string;
    customWebhookUrl: string;
    reminderNumber?: number;
    includeAckButton?: boolean;
  }
): Promise<WebhookDispatchResult> {
  const token = opts.telegramBotToken.trim();
  const chatId = opts.telegramChatId.trim();
  const customUrl = opts.customWebhookUrl.trim();
  const reminderNum = opts.reminderNumber ?? 1;
  const includeAckButton = opts.includeAckButton ?? true;

  if (!token && !customUrl) {
    return {
      sent: false,
      status: 'skipped',
      detail: 'Aucun token Telegram ou webhook configure',
    };
  }

  const results: string[] = [];
  let anySuccess = false;
  let anyFailure = false;
  let telegramMessageId: number | undefined;

  if (token && chatId) {
    try {
      const payload: Record<string, unknown> = {
        chat_id: chatId,
        text: formatTelegramMessage(alert, reminderNum),
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      };

      if (includeAckButton) {
        payload.reply_markup = {
          inline_keyboard: [
            [
              {
                text: "✅ J'ai vu — Valider",
                callback_data: `ack:${alert.symbol}:${alert.timestamp}`,
              },
            ],
          ],
        };
      }

      const tgRes = await tgFetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const tgData = (await tgRes.json().catch(() => ({}))) as {
        ok?: boolean;
        description?: string;
        result?: { message_id?: number };
      };
      if (tgRes.ok && tgData.ok) {
        anySuccess = true;
        telegramMessageId = tgData.result?.message_id;
        results.push(
          reminderNum > 1 ? `Telegram Rappel #${reminderNum} OK` : 'Telegram HTTP 200 OK'
        );
      } else {
        anyFailure = true;
        results.push(`Telegram erreur: ${tgData.description ?? `HTTP ${tgRes.status}`}`);
      }
    } catch (err) {
      anyFailure = true;
      results.push(`Telegram exception: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else if (token && !chatId) {
    anyFailure = true;
    results.push('Chat ID Telegram manquant');
  }

  if (customUrl) {
    try {
      const whRes = await tgFetch(customUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'ICT_KILLZONE_CISD_CONFLUENCE',
          reminderNumber: reminderNum,
          alert,
          message: formatTelegramMessage(alert, reminderNum),
        }),
      });
      if (whRes.ok) {
        anySuccess = true;
        results.push(`Webhook HTTP ${whRes.status}`);
      } else {
        anyFailure = true;
        results.push(`Webhook HTTP ${whRes.status}`);
      }
    } catch (err) {
      anyFailure = true;
      results.push(`Webhook exception: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    sent: anySuccess && !anyFailure,
    status: anyFailure && !anySuccess ? 'failed' : anySuccess ? 'sent' : 'skipped',
    detail: results.join(' | '),
    telegramMessageId,
  };
}

export interface TelegramUpdateItem {
  update_id: number;
  callback_query?: {
    id: string;
    data?: string;
    message?: {
      message_id: number;
      chat?: { id: number | string };
    };
  };
  message?: {
    message_id: number;
    text?: string;
    chat?: { id: number | string };
  };
}

export async function fetchTelegramUpdates(
  token: string,
  offset: number
): Promise<TelegramUpdateItem[]> {
  if (!token.trim()) return [];
  try {
    const res = await tgFetch(
      `https://api.telegram.org/bot${token.trim()}/getUpdates?offset=${offset}&timeout=0&allowed_updates=${encodeURIComponent(
        JSON.stringify(['callback_query', 'message'])
      )}`
    );
    if (!res.ok) return [];
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      result?: TelegramUpdateItem[];
    };
    return data.ok && Array.isArray(data.result) ? data.result : [];
  } catch {
    return [];
  }
}

export async function answerTelegramCallback(
  token: string,
  callbackQueryId: string,
  text: string,
  chatId?: number | string,
  messageId?: number
): Promise<void> {
  const cleanToken = token.trim();
  if (!cleanToken) return;
  try {
    await tgFetch(`https://api.telegram.org/bot${cleanToken}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
        show_alert: false,
      }),
    });
    if (chatId !== undefined && messageId !== undefined) {
      await tgFetch(`https://api.telegram.org/bot${cleanToken}/editMessageReplyMarkup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          message_id: messageId,
          reply_markup: { inline_keyboard: [] },
        }),
      });
    }
  } catch {
    // Non-fatal callback feedback error
  }
}

export async function sendTelegramSimpleText(
  token: string,
  chatId: string,
  text: string
): Promise<void> {
  if (!token.trim() || !chatId.trim()) return;
  try {
    await tgFetch(`https://api.telegram.org/bot${token.trim()}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId.trim(),
        text,
        parse_mode: 'HTML',
      }),
    });
  } catch {
    // Non-fatal confirmation text error
  }
}
