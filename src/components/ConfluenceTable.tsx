import React, { useMemo, useState } from 'react';
import {
  formatSymbolPrice,
  type ConfluenceAlert,
  type KillzoneSweepEvent,
  type SupportedSymbol,
} from '../engine/types';

interface ConfluenceTableProps {
  symbol: SupportedSymbol;
  alerts: ConfluenceAlert[];
  sweeps: KillzoneSweepEvent[];
  onTestWebhook: () => void;
  testingWebhook: boolean;
  onAcknowledgeAlert: (id: string) => Promise<void>;
  acknowledgingId: string | null;
}

function formatNyTime(ts: number): string {
  const d = new Date(ts);
  const mo = d.getUTCMonth() + 1;
  const dy = d.getUTCDate();
  const dw = d.getUTCDay();
  let offset = -5;
  if (
    (mo > 3 && mo < 11) ||
    (mo === 3 && ((dy >= 8 && dy <= 14 && dw === 0) || dy > 14)) ||
    (mo === 11 && ((dy < 7 && dw !== 0) || (dy === 7 && dw !== 0)))
  ) {
    offset = -4;
  }
  const shifted = new Date(ts + offset * 3600 * 1000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(shifted.getUTCDate())}/${pad(shifted.getUTCMonth() + 1)} ${pad(
    shifted.getUTCHours()
  )}:${pad(shifted.getUTCMinutes())}`;
}

export const ConfluenceTable: React.FC<ConfluenceTableProps> = ({
  symbol,
  alerts,
  sweeps,
  onTestWebhook,
  testingWebhook,
  onAcknowledgeAlert,
  acknowledgingId,
}) => {
  const [filter, setFilter] = useState<'ALL' | 'PENDING' | 'HIGH' | 'BULLISH' | 'BEARISH'>('ALL');
  const [viewMode, setViewMode] = useState<'confluences' | 'sweeps'>('confluences');

  const pendingCount = useMemo(
    () => alerts.filter((a) => a.ackStatus === 'pending').length,
    [alerts]
  );

  const filteredAlerts = useMemo(() => {
    if (filter === 'ALL') return alerts;
    if (filter === 'PENDING') return alerts.filter((a) => a.ackStatus === 'pending');
    if (filter === 'HIGH') return alerts.filter((a) => a.probability === 'HIGH');
    return alerts.filter((a) => a.direction === filter);
  }, [alerts, filter]);

  return (
    <div className="bg-[#111827] border border-[#1E293B] rounded-lg overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3 border-b border-[#1E293B]">
        <div className="flex items-center gap-4">
          <h2 className="text-sm font-semibold text-[#F1F5F9] whitespace-nowrap">
            Historique des signaux et balayages
          </h2>
          <div className="flex items-center bg-[#0B0F17] border border-[#1E293B] rounded-md p-0.5">
            <button
              type="button"
              onClick={() => setViewMode('confluences')}
              className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                viewMode === 'confluences'
                  ? 'bg-[#1E293B] text-[#F8FAFC]'
                  : 'text-[#64748B] hover:text-[#CBD5E1]'
              }`}
            >
              Confluences ({alerts.length})
            </button>
            <button
              type="button"
              onClick={() => setViewMode('sweeps')}
              className={`px-3 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                viewMode === 'sweeps'
                  ? 'bg-[#1E293B] text-[#F8FAFC]'
                  : 'text-[#64748B] hover:text-[#CBD5E1]'
              }`}
            >
              Sweeps Killzone ({sweeps.length})
            </button>
          </div>
        </div>

        {viewMode === 'confluences' && (
          <div className="flex flex-wrap items-center gap-1 bg-[#0B0F17] border border-[#1E293B] rounded-md p-0.5">
            {(['ALL', 'PENDING', 'HIGH', 'BULLISH', 'BEARISH'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  filter === f
                    ? 'bg-[#1E293B] text-[#F8FAFC]'
                    : f === 'PENDING' && pendingCount > 0
                    ? 'text-[#F59E0B] hover:text-[#FBBF24]'
                    : 'text-[#64748B] hover:text-[#CBD5E1]'
                }`}
              >
                {f === 'ALL'
                  ? 'Tous'
                  : f === 'PENDING'
                  ? `En cours (${pendingCount})`
                  : f === 'HIGH'
                  ? 'Probabilite Elevee'
                  : f === 'BULLISH'
                  ? 'Haussier'
                  : 'Baissier'}
              </button>
            ))}
          </div>
        )}
      </div>

      {viewMode === 'confluences' ? (
        filteredAlerts.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <p className="text-sm text-[#94A3B8]">
              Aucun signal Killzone + CISD M3/M5 pour ce filtre.
            </p>
            <p className="mt-1 text-xs text-[#64748B]">
              Les signaux historiques sont conserves dans ce journal. Les alertes Telegram sont repetees jusqu’a « J’ai vu » (10 envois maximum).
            </p>
            <button
              type="button"
              onClick={onTestWebhook}
              disabled={testingWebhook}
              className="mt-4 px-4 py-2 text-xs font-medium bg-[#1E293B] hover:bg-[#334155] text-[#F8FAFC] rounded-md transition-colors cursor-pointer disabled:opacity-50"
            >
              {testingWebhook ? 'Envoi en cours...' : 'Envoyer une alerte test Telegram'}
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#1E293B] text-[11px] font-medium text-[#64748B]">
                  <th className="py-2.5 px-4 whitespace-nowrap">Heure NY</th>
                  <th className="py-2.5 px-4 whitespace-nowrap">Direction / TF</th>
                  <th className="py-2.5 px-4 whitespace-nowrap">Probabilite (D1 / H4)</th>
                  <th className="py-2.5 px-4 whitespace-nowrap">Session Active</th>
                  <th className="py-2.5 px-4 whitespace-nowrap">Niveau Casse</th>
                  <th className="py-2.5 px-4 whitespace-nowrap">Position Prix</th>
                  <th className="py-2.5 px-4 text-right whitespace-nowrap">Origine CISD</th>
                  <th className="py-2.5 px-4 whitespace-nowrap">Validation (J'ai vu)</th>
                  <th className="py-2.5 px-4 whitespace-nowrap">Statut Webhook</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1E293B]/60 text-xs">
                {filteredAlerts.map((a) => {
                  const isBull = a.direction === 'BULLISH';
                  return (
                    <tr
                      key={a.id}
                      className={
                        a.ackStatus === 'pending'
                          ? 'bg-[#F59E0B]/5 hover:bg-[#F59E0B]/10 transition-colors'
                          : 'hover:bg-[#1E293B]/35 transition-colors'
                      }
                    >
                      <td className="py-2.5 px-4 font-mono tabular-nums text-[#CBD5E1] whitespace-nowrap">
                        {a.nyTimeStr}
                      </td>
                      <td className="py-2.5 px-4 font-medium whitespace-nowrap">
                        <span className={isBull ? 'text-[#10B981]' : 'text-[#EF4444]'}>
                          {isBull ? '▲ HAUSSIER' : '▼ BAISSIER'}
                        </span>
                        <span className="ml-2 rounded bg-[#1E293B] px-1.5 py-0.5 text-[10px] text-[#CBD5E1]">{a.timeframe ?? 'M3'}</span>
                      </td>
                      <td className="py-2.5 px-4 whitespace-nowrap">
                        {a.probability === 'HIGH' ? (
                          <span className="font-semibold text-[#10B981]">
                            PROBABILITE ELEVEE · D1+H4
                          </span>
                        ) : a.probability === 'MEDIUM' ? (
                          <span className="text-[#F59E0B]">
                            Moyenne · D1 {a.dailyBias === 'BULLISH' ? 'H' : a.dailyBias === 'BEARISH' ? 'B' : '-'} / H4{' '}
                            {a.h4Bias === 'BULLISH' ? 'H' : a.h4Bias === 'BEARISH' ? 'B' : '-'}
                          </span>
                        ) : (
                          <span className="text-[#94A3B8]">Contre-tendance</span>
                        )}
                      </td>
                      <td className="py-2.5 px-4 text-[#E2E8F0] whitespace-nowrap">
                        {a.activeKillzoneName ?? 'Hors KZ'}
                      </td>
                      <td className="py-2.5 px-4 text-[#E2E8F0] whitespace-nowrap">
                        {(a.kzSweeps?.length ? a.kzSweeps : [a.kzSweep]).map((sw) => (
                          <div key={sw.id} className="font-mono tabular-nums text-[#CBD5E1]">
                            {sw.shortName}.{sw.isHigh ? 'H' : 'L'} <span className="text-[#94A3B8]">{formatSymbolPrice(sw.level, a.symbol)}</span>
                          </div>
                        ))}
                      </td>
                      <td className="py-2.5 px-4 whitespace-nowrap">
                        <span className={a.isPreReentry ? 'text-[#F59E0B] font-medium' : 'text-[#94A3B8]'}>
                          {a.isPreReentry ? 'Avant reintegration' : 'Reintegre'}
                        </span>
                        {a.isIntrabarSignal && (
                          <span className="text-[#64748B] ml-1.5">· Intrabar</span>
                        )}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-[#F1F5F9] whitespace-nowrap">
                        {formatSymbolPrice(a.cisd.originLevel, a.symbol)}
                      </td>
                      <td className="py-2.5 px-4 whitespace-nowrap">
                        {a.ackStatus === 'pending' ? (
                          <div className="flex items-center gap-2">
                            <span className="text-[#F59E0B] font-medium font-mono tabular-nums">
                              En cours · 1 notification
                            </span>
                            <button
                              type="button"
                              onClick={() => void onAcknowledgeAlert(a.id)}
                              disabled={acknowledgingId === a.id}
                              className="px-2.5 py-1 text-[11px] font-semibold bg-[#10B981] hover:bg-[#059669] text-[#0B0F17] rounded transition-colors cursor-pointer disabled:opacity-50"
                            >
                              {acknowledgingId === a.id ? '...' : "Valider (J'ai vu)"}
                            </button>
                          </div>
                        ) : a.ackStatus === 'acknowledged' ? (
                          <span className="text-[#10B981] font-medium">
                            Vu / Valide ({a.acknowledgedBy === 'telegram' ? 'Telegram' : 'App'})
                          </span>
                        ) : a.ackStatus === 'expired' ? (
                          <span className="text-[#64748B]">Expire</span>
                        ) : a.ackStatus === 'invalidated' ? (
                          <span className="text-[#EF4444] font-medium">Invalide · SL touche · surveillance 60 min</span>
                        ) : (
                          <span className="text-[#64748B]">Passe (ignore)</span>
                        )}
                      </td>
                      <td className="py-2.5 px-4 whitespace-nowrap">
                        <span
                          className={
                            a.webhookStatus === 'sent'
                              ? 'text-[#10B981]'
                              : a.webhookStatus === 'failed'
                              ? 'text-[#EF4444]'
                              : 'text-[#94A3B8]'
                          }
                        >
                          {a.webhookStatus === 'sent'
                            ? a.reminderCount > 1
                              ? `Envoye (x${a.reminderCount})`
                              : 'Envoye'
                            : a.webhookStatus === 'failed'
                            ? `Echec (${a.webhookDetail ?? ''})`
                            : a.webhookStatus === 'pending'
                            ? 'Envoi...'
                            : a.webhookDetail ?? 'Historique'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )
      ) : sweeps.length === 0 ? (
        <div className="px-6 py-10 text-center text-sm text-[#94A3B8]">
          Aucun balayage de Killzone enregistre sur la periode chargee.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-[#1E293B] text-[11px] font-medium text-[#64748B]">
                <th className="py-2.5 px-4 whitespace-nowrap">Heure NY</th>
                <th className="py-2.5 px-4 whitespace-nowrap">Session</th>
                <th className="py-2.5 px-4 whitespace-nowrap">Type</th>
                <th className="py-2.5 px-4 text-right whitespace-nowrap">Niveau Balaye</th>
                <th className="py-2.5 px-4 text-right whitespace-nowrap">Meche Atteinte</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1E293B]/60 text-xs">
              {sweeps.slice(0, 40).map((s) => (
                <tr key={s.id} className="hover:bg-[#1E293B]/35 transition-colors">
                  <td className="py-2.5 px-4 font-mono tabular-nums text-[#CBD5E1] whitespace-nowrap">
                    {formatNyTime(s.sweptAt)}
                  </td>
                  <td className="py-2.5 px-4 text-[#E2E8F0] whitespace-nowrap">{s.sessionName}</td>
                  <td className="py-2.5 px-4 whitespace-nowrap">
                    <span className={s.isHigh ? 'text-[#EF4444]' : 'text-[#10B981]'}>
                      {s.isHigh ? `${s.shortName}.H (BSL)` : `${s.shortName}.L (SSL)`}
                    </span>
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono tabular-nums text-[#F1F5F9] whitespace-nowrap">
                    {formatSymbolPrice(s.level, symbol)}
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono tabular-nums text-[#94A3B8] whitespace-nowrap">
                    {formatSymbolPrice(s.sweepPrice, symbol)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};
