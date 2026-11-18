import type { ConfluenceAlert } from './types.ts';

export interface WebhookDispatchResult {
  sent: boolean;
  status: 'sent' | 'skipped' | 'failed';
  detail: string;
}

export function formatTelegramMessage(alert: ConfluenceAlert): string {
  const dirLabel = alert.direction === 'BULLISH' ? 'BULLISH REVERSAL' : 'BEARISH REVERSAL';
  const arrow = alert.direction === 'BULLISH' ? '▲' : '▼';
  const sweepType = alert.kzSweep.isHigh ? `${alert.kzSweep.shortName}.H` : `${alert.kzSweep.shortName}.L`;
  const swingLine = alert.hasInternalSwingSweep
    ? `\n• <b>Swing Sweep AlgoAlpha :</b> Confirme (${alert.cisd.wickedSwingLevel?.toFixed(2) ?? '-'})`
    : '';

  return [
    `<b>${arrow} CONFLUENCE ICT — ${alert.symbol} M3</b>`,
    `<b>Direction :</b> ${dirLabel}`,
    `<b>Killzone Swept :</b> ${alert.kzSweep.sessionName} (${sweepType}) @ <code>${alert.kzSweep.level.toFixed(2)}</code>`,
    `<b>Prix de Sweep :</b> <code>${alert.kzSweep.sweepPrice.toFixed(2)}</code>`,
    `<b>CISD M3 Origin :</b> <code>${alert.cisd.originLevel.toFixed(2)}</code> (Cloture: <code>${alert.cisd.closePrice.toFixed(2)}</code>)`,
    `<b>Ratio Bruit CISD :</b> <code>${alert.cisd.noiseRatio.toFixed(2)}</code> (&gt; ${alert.cisd.toleranceUsed})`,
    `<b>Delai Sweep → CISD :</b> ${alert.barsBetweenSweepAndCisd} bougie(s) M3${swingLine}`,
    `<b>Heure NY :</b> <code>${alert.nyTimeStr}</code>`,
  ].join('\n');
}

export async function dispatchAlertWebhook(
  alert: ConfluenceAlert,
  opts: {
    telegramBotToken: string;
    telegramChatId: string;
    customWebhookUrl: string;
  }
): Promise<WebhookDispatchResult> {
  const token = opts.telegramBotToken.trim();
  const chatId = opts.telegramChatId.trim();
  const customUrl = opts.customWebhookUrl.trim();

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

  if (token && chatId) {
    try {
      const tgRes = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: formatTelegramMessage(alert),
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      const tgData = (await tgRes.json().catch(() => ({}))) as { ok?: boolean; description?: string };
      if (tgRes.ok && tgData.ok) {
        anySuccess = true;
        results.push('Telegram HTTP 200 OK');
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
      const whRes = await fetch(customUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'ICT_KILLZONE_CISD_CONFLUENCE',
          alert,
          message: formatTelegramMessage(alert),
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
  };
}
