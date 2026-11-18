import React, { useMemo, useState } from 'react';
import type { ConfluenceAlert, KillzoneSweepEvent } from '../engine/types';

interface ConfluenceTableProps {
  alerts: ConfluenceAlert[];
  sweeps: KillzoneSweepEvent[];
  onTestWebhook: () => void;
  testingWebhook: boolean;
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
  alerts,
  sweeps,
  onTestWebhook,
  testingWebhook,
}) => {
  const [filter, setFilter] = useState<'ALL' | 'BULLISH' | 'BEARISH'>('ALL');
  const [viewMode, setViewMode] = useState<'confluences' | 'sweeps'>('confluences');

  const filteredAlerts = useMemo(() => {
    if (filter === 'ALL') return alerts;
    return alerts.filter((a) => a.direction === filter);
  }, [alerts, filter]);

  return (
    <div className="bg-[#111827] border border-[#1E293B] rounded-lg overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3 border-b border-[#1E293B]">
        <div className="flex items-center gap-4">
          <h2 className="text-sm font-semibold text-[#F1F5F9] whitespace-nowrap">
            Journal de Confluence et Balayages
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
          <div className="flex items-center gap-1 bg-[#0B0F17] border border-[#1E293B] rounded-md p-0.5">
            {(['ALL', 'BULLISH', 'BEARISH'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFilter(f)}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  filter === f
                    ? 'bg-[#1E293B] text-[#F8FAFC]'
                    : 'text-[#64748B] hover:text-[#CBD5E1]'
                }`}
              >
                {f === 'ALL' ? 'Tous' : f === 'BULLISH' ? 'Haussier' : 'Baissier'}
              </button>
            ))}
          </div>
        )}
      </div>

      {viewMode === 'confluences' ? (
        filteredAlerts.length === 0 ? (
          <div className="px-6 py-10 text-center">
            <p className="text-sm text-[#94A3B8]">
              Aucune confluence balayage Killzone + CISD M3 validee sur l'historique actif pour ce filtre.
            </p>
            <p className="mt-1 text-xs text-[#64748B]">
              Le moteur surveille en continu chaque cloture M3 de XAU/USD et declenchera Telegram automatiquement.
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
                  <th className="py-2.5 px-4 whitespace-nowrap">Direction</th>
                  <th className="py-2.5 px-4 whitespace-nowrap">Niveau Killzone</th>
                  <th className="py-2.5 px-4 text-right whitespace-nowrap">Prix Sweep</th>
                  <th className="py-2.5 px-4 text-right whitespace-nowrap">Origine CISD M3</th>
                  <th className="py-2.5 px-4 text-right whitespace-nowrap">Ratio Bruit</th>
                  <th className="py-2.5 px-4 text-right whitespace-nowrap">Delai</th>
                  <th className="py-2.5 px-4 whitespace-nowrap">Statut Webhook</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1E293B]/60 text-xs">
                {filteredAlerts.map((a) => {
                  const isBull = a.direction === 'BULLISH';
                  return (
                    <tr key={a.id} className="hover:bg-[#1E293B]/35 transition-colors">
                      <td className="py-2.5 px-4 font-mono tabular-nums text-[#CBD5E1] whitespace-nowrap">
                        {a.nyTimeStr}
                      </td>
                      <td className="py-2.5 px-4 font-medium whitespace-nowrap">
                        <span className={isBull ? 'text-[#10B981]' : 'text-[#EF4444]'}>
                          {isBull ? '▲ HAUSSIER' : '▼ BAISSIER'}
                        </span>
                      </td>
                      <td className="py-2.5 px-4 text-[#E2E8F0] whitespace-nowrap">
                        {a.kzSweep.sessionName} · {a.kzSweep.shortName}.
                        {a.kzSweep.isHigh ? 'H' : 'L'}{' '}
                        <span className="font-mono tabular-nums text-[#94A3B8]">
                          ({a.kzSweep.level.toFixed(2)})
                        </span>
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-[#F1F5F9] whitespace-nowrap">
                        {a.kzSweep.sweepPrice.toFixed(2)}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-[#F1F5F9] whitespace-nowrap">
                        {a.cisd.originLevel.toFixed(2)}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-[#CBD5E1] whitespace-nowrap">
                        {a.cisd.noiseRatio.toFixed(2)} / {a.cisd.toleranceUsed}
                      </td>
                      <td className="py-2.5 px-4 text-right font-mono tabular-nums text-[#94A3B8] whitespace-nowrap">
                        {a.barsBetweenSweepAndCisd} M3
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
                            ? 'Envoye'
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
                    {s.level.toFixed(2)}
                  </td>
                  <td className="py-2.5 px-4 text-right font-mono tabular-nums text-[#94A3B8] whitespace-nowrap">
                    {s.sweepPrice.toFixed(2)}
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
