import { formatSymbolPrice, type ConfluenceAlert } from './types.ts';

export interface WebhookDispatchResult {
  sent: boolean;
  status: 'sent' | 'skipped' | 'failed';
  detail: string;
}

function biasFr(b: 'BULLISH' | 'BEARISH' | 'NEUTRAL'): string {
  return b === 'BULLISH' ? 'HAUSSIER' : b === 'BEARISH' ? 'BAISSIER' : 'NEUTRE';
}

export function formatTelegramMessage(alert: ConfluenceAlert): string {
  const fmt = (p: number) => formatSymbolPrice(p, alert.symbol);
  const dirLabel = alert.direction === 'BULLISH' ? 'RETOURNEMENT HAUSSIER' : 'RETOURNEMENT BAISSIER';
  const arrow = alert.direction === 'BULLISH' ? '▲' : '▼';
  const sweepType = alert.kzSweep.isHigh ? `${alert.kzSweep.shortName}.H` : `${alert.kzSweep.shortName}.L`;
  const phaseLabel = alert.isPreReentry
    ? 'AVANT REINTEGRATION (Prix encore hors niveau)'
    : 'REINTEGRATION CONFIRMEE';
  const timingLabel = alert.isIntrabarSignal ? 'Temps reel (Intrabar M3)' : 'Cloture M3 confirmee';
  const sessionLabel = alert.activeKillzoneName ?? 'Hors Killzone';
  const probHeader =
    alert.probability === 'HIGH'
      ? `<b>★ PROBABILITE ELEVEE (Alignement Daily + H4) ★</b>\n`
      : alert.probability === 'MEDIUM'
      ? `<b>Probabilite Moyenne (1/2 HTF aligne)</b>\n`
      : `<b>Contre-Tendance HTF</b>\n`;
  const swingLine = alert.hasInternalSwingSweep
    ? `\n• <b>Swing Sweep AlgoAlpha :</b> Confirme (${
        alert.cisd.wickedSwingLevel !== null ? fmt(alert.cisd.wickedSwingLevel) : '-'
      })`
    : '';

  return [
    `${probHeader}<b>${arrow} SIGNAL CONFLUENCE — ${alert.symbol} M3</b>`,
    `<b>Direction :</b> ${dirLabel}`,
    `<b>Biais HTF :</b> Daily <code>${biasFr(alert.dailyBias)}</code> · H4 <code>${biasFr(alert.h4Bias)}</code>`,
    `<b>Killzone Active :</b> ${sessionLabel}`,
    `<b>Cassure Niveau :</b> ${alert.kzSweep.sessionName} (${sweepType}) @ <code>${fmt(alert.kzSweep.level)}</code>`,
    `<b>Prix Actuel / Sweep :</b> <code>${fmt(alert.cisd.closePrice)}</code> (Meche: <code>${fmt(alert.kzSweep.sweepPrice)}</code>)`,
    `<b>Position Prix :</b> ${phaseLabel}`,
    `<b>CISD M3 Contraire :</b> Origine <code>${fmt(alert.cisd.originLevel)}</code> · Ratio <code>${alert.cisd.noiseRatio.toFixed(2)}</code> (&gt; ${alert.cisd.toleranceUsed})`,
    `<b>Declenchement :</b> ${timingLabel} · Delai ${alert.barsBetweenSweepAndCisd} bougie(s) M3${swingLine}`,
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
