import React, { useCallback, useEffect, useState } from 'react';
import { ConfluenceTable } from './components/ConfluenceTable';
import { IntegrationSettings } from './components/IntegrationSettings';
import { XauChart } from './components/XauChart';
import type { EngineSnapshot } from './engine/types';

type NavTab = 'terminal' | 'killzones' | 'alerts' | 'settings';

export default function App() {
  const [snapshot, setSnapshot] = useState<EngineSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<NavTab>('terminal');
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [testingWebhook, setTestingWebhook] = useState<boolean>(false);
  const [toastMsg, setToastMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let eventSource: EventSource | null = null;
    let active = true;

    const init = async () => {
      try {
        const res = await fetch('/api/state');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as EngineSnapshot;
        if (active) {
          setSnapshot(data);
          setLoading(false);
        }
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Erreur de connexion au serveur');
          setLoading(false);
        }
      }

      eventSource = new EventSource('/api/stream');
      eventSource.onmessage = (ev) => {
        try {
          const parsed = JSON.parse(ev.data) as EngineSnapshot;
          if (active) {
            setSnapshot(parsed);
            setLoading(false);
          }
        } catch {
          // Ignore keepalive or malformed frame
        }
      };
    };

    void init();

    return () => {
      active = false;
      eventSource?.close();
    };
  }, []);

  const showToast = useCallback((ok: boolean, text: string) => {
    setToastMsg({ ok, text });
    setTimeout(() => setToastMsg(null), 5000);
  }, []);

  const handleRefreshFeed = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/feed/refresh', { method: 'POST' });
      const data = (await res.json()) as { ok: boolean; snapshot?: EngineSnapshot };
      if (data.snapshot) setSnapshot(data.snapshot);
      showToast(true, 'Flux reel XAU/USD synchronise.');
    } catch (err) {
      showToast(false, err instanceof Error ? err.message : 'Echec synchronisation');
    } finally {
      setRefreshing(false);
    }
  }, [showToast]);

  const handleSaveConfig = useCallback(async (patch: Record<string, unknown>) => {
    const res = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
    const data = (await res.json()) as { ok: boolean; snapshot?: EngineSnapshot; error?: string };
    if (!res.ok || !data.ok) {
      throw new Error(data.error ?? 'Echec de mise a jour');
    }
    if (data.snapshot) setSnapshot(data.snapshot);
  }, []);

  const handleTestWebhook = useCallback(async () => {
    setTestingWebhook(true);
    try {
      const res = await fetch('/api/webhook/test', { method: 'POST' });
      const data = (await res.json()) as { ok: boolean; detail: string };
      showToast(data.ok, data.detail || (data.ok ? 'Telegram envoye' : 'Echec envoi'));
      return { ok: data.ok, detail: data.detail };
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Erreur reseau';
      showToast(false, msg);
      return { ok: false, detail: msg };
    } finally {
      setTestingWebhook(false);
    }
  }, [showToast]);

  const latestCandle = snapshot?.candles[snapshot.candles.length - 1] ?? null;
  const activeUnswept = snapshot?.unsweptLevels.filter((l) => !l.swept) ?? [];
  const latestTrend = snapshot?.candleTrends[snapshot.candleTrends.length - 1] ?? 0;

  return (
    <div className="min-h-screen bg-[#0B0F17] text-[#F1F5F9] flex flex-col">
      {/* Top Bar Contract: 3 zones (Wordmark — 4 Nav Links — 1 Primary Action) */}
      <header className="border-b border-[#1E293B] bg-[#0B0F17]">
        <div className="max-w-[1440px] mx-auto px-6 py-3.5 flex items-center justify-between gap-8">
          <a
            href="#terminal"
            onClick={(e) => {
              e.preventDefault();
              setActiveTab('terminal');
            }}
            className="text-base font-bold tracking-tight text-[#F8FAFC] whitespace-nowrap shrink-0"
          >
            Killzone CISD Desk
          </a>

          <nav className="flex items-center gap-6 overflow-x-auto">
            {(
              [
                { id: 'terminal', label: 'Terminal' },
                { id: 'killzones', label: 'Killzones' },
                { id: 'alerts', label: 'Alertes' },
                { id: 'settings', label: 'Parametres' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`text-sm font-medium transition-colors whitespace-nowrap shrink-0 pb-0.5 border-b cursor-pointer ${
                  activeTab === tab.id
                    ? 'text-[#F8FAFC] border-[#2563EB]'
                    : 'text-[#94A3B8] border-transparent hover:text-[#F1F5F9]'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </nav>

          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={() => void handleTestWebhook()}
              disabled={testingWebhook || !snapshot}
              className="px-4 py-2 text-xs font-medium bg-[#2563EB] hover:bg-[#1D4ED8] text-white rounded-md transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 cursor-pointer"
            >
              {testingWebhook ? 'Envoi...' : 'Tester Webhook'}
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-[1440px] w-full mx-auto px-6 py-6 flex flex-col gap-6">
        {toastMsg && (
          <div
            className={`px-4 py-2.5 text-xs rounded-md border flex items-center justify-between ${
              toastMsg.ok
                ? 'bg-[#10B981]/10 border-[#10B981]/40 text-[#10B981]'
                : 'bg-[#EF4444]/10 border-[#EF4444]/40 text-[#EF4444]'
            }`}
          >
            <span>{toastMsg.text}</span>
            <button
              type="button"
              onClick={() => setToastMsg(null)}
              className="text-xs underline ml-4 cursor-pointer"
            >
              Fermer
            </button>
          </div>
        )}

        {loading && !snapshot ? (
          <div className="bg-[#111827] border border-[#1E293B] rounded-lg p-10 text-center">
            <p className="text-sm text-[#94A3B8]">
              Connexion aux donnees reelles XAU/USD M3 et calcul des sessions Killzones...
            </p>
          </div>
        ) : error && !snapshot ? (
          <div className="bg-[#111827] border border-[#1E293B] rounded-lg p-10 text-center">
            <p className="text-sm text-[#EF4444]">{error}</p>
          </div>
        ) : snapshot ? (
          <>
            {/* 4-Column KPI Summary Row */}
            <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
              <div className="bg-[#111827] border border-[#1E293B] rounded-lg px-4 py-3.5">
                <div className="text-xs text-[#94A3B8] flex items-center gap-1.5">
                  <span>XAU/USD Spot</span>
                  <span aria-hidden="true">·</span>
                  <span>M3 Reel</span>
                </div>
                <div className="mt-1.5 flex items-baseline justify-between gap-2">
                  <span className="text-xl font-semibold font-mono tabular-nums text-[#F8FAFC]">
                    {latestCandle ? latestCandle.close.toFixed(2) : '-'}
                  </span>
                  <span
                    className={`text-xs font-medium ${
                      latestTrend > 0
                        ? 'text-[#10B981]'
                        : latestTrend < 0
                        ? 'text-[#EF4444]'
                        : 'text-[#94A3B8]'
                    }`}
                  >
                    {latestTrend > 0 ? 'CISD HAUSSIER' : latestTrend < 0 ? 'CISD BAISSIER' : 'NEUTRE'}
                  </span>
                </div>
              </div>

              <div className="bg-[#111827] border border-[#1E293B] rounded-lg px-4 py-3.5">
                <div className="text-xs text-[#94A3B8] flex items-center gap-1.5">
                  <span>Session New York</span>
                  <span aria-hidden="true">·</span>
                  <span>{snapshot.countdown.nyTimezone}</span>
                </div>
                <div className="mt-1.5 flex items-baseline justify-between gap-2">
                  <span
                    className={`text-sm font-semibold font-mono tabular-nums truncate ${
                      snapshot.countdown.activeSessionId
                        ? snapshot.countdown.isWarning
                          ? 'text-[#F59E0B]'
                          : 'text-[#10B981]'
                        : 'text-[#E2E8F0]'
                    }`}
                  >
                    {snapshot.countdown.statusText}
                  </span>
                </div>
              </div>

              <div className="bg-[#111827] border border-[#1E293B] rounded-lg px-4 py-3.5">
                <div className="text-xs text-[#94A3B8] flex items-center gap-1.5">
                  <span>Liquidite Non Balayee</span>
                  <span aria-hidden="true">·</span>
                  <span>Actifs</span>
                </div>
                <div className="mt-1.5 flex items-baseline justify-between gap-2">
                  <span className="text-xl font-semibold font-mono tabular-nums text-[#F8FAFC]">
                    {activeUnswept.length}
                  </span>
                  <span className="text-xs font-mono tabular-nums text-[#94A3B8]">
                    {snapshot.sweepEvents.length} sweeps enregistres
                  </span>
                </div>
              </div>

              <div className="bg-[#111827] border border-[#1E293B] rounded-lg px-4 py-3.5">
                <div className="text-xs text-[#94A3B8] flex items-center gap-1.5">
                  <span>Confluences Detectees</span>
                  <span aria-hidden="true">·</span>
                  <span>Telegram</span>
                </div>
                <div className="mt-1.5 flex items-baseline justify-between gap-2">
                  <span className="text-xl font-semibold font-mono tabular-nums text-[#F8FAFC]">
                    {snapshot.confluenceAlerts.length}
                  </span>
                  <span
                    className={`text-xs font-medium ${
                      snapshot.config.hasTelegramToken && snapshot.config.alertsEnabled
                        ? 'text-[#10B981]'
                        : 'text-[#94A3B8]'
                    }`}
                  >
                    {snapshot.config.hasTelegramToken && snapshot.config.alertsEnabled
                      ? `Bot actif (${snapshot.config.telegramChatId})`
                      : 'Alertes en pause'}
                  </span>
                </div>
              </div>
            </section>

            {/* Terminal View */}
            {activeTab === 'terminal' && (
              <>
                <section className="grid grid-cols-1 xl:grid-cols-[1fr_330px] gap-6 items-start">
                  <XauChart
                    candles={snapshot.candles}
                    candleTrends={snapshot.candleTrends}
                    sessions={snapshot.sessions}
                    unsweptLevels={snapshot.unsweptLevels}
                    swingPivots={snapshot.swingPivots}
                    cisdSignals={snapshot.cisdSignals}
                    confluenceAlerts={snapshot.confluenceAlerts}
                    tzMode={snapshot.config.tzMode}
                    onRefresh={() => void handleRefreshFeed()}
                    refreshing={refreshing}
                  />

                  {/* Right Rail: Pine Script Info Panel equivalent */}
                  <aside className="bg-[#111827] border border-[#1E293B] rounded-lg overflow-hidden flex flex-col">
                    <div className="px-4 py-3 border-b border-[#1E293B] flex items-center justify-between">
                      <span className="text-sm font-semibold text-[#F1F5F9]">Session Killzones</span>
                      <span className="text-xs font-mono tabular-nums text-[#94A3B8]">
                        {snapshot.countdown.nyTimezone} {snapshot.countdown.isDst ? 'EDT' : 'EST'}
                      </span>
                    </div>

                    <div className="px-4 py-2.5 border-b border-[#1E293B] bg-[#0F1521] flex items-center justify-between text-xs">
                      <span className="text-[#94A3B8]">Heure NY</span>
                      <span className="font-mono tabular-nums text-[#E2E8F0]">
                        {snapshot.countdown.nyTimeFormatted}
                      </span>
                    </div>

                    {/* 4 Sessions Summary */}
                    <div className="divide-y divide-[#1E293B]/60">
                      {snapshot.daySummaries.map((s) => (
                        <div
                          key={s.id}
                          className="px-4 py-2.5 flex items-center justify-between gap-3 text-xs"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            <span
                              className="w-2 h-2 rounded-xs shrink-0"
                              style={{ backgroundColor: s.color }}
                            />
                            <span className="font-medium text-[#F1F5F9] whitespace-nowrap">
                              {s.name}
                            </span>
                            <span className="font-mono tabular-nums text-[#64748B]">
                              {s.range}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 shrink-0 font-mono tabular-nums">
                            {s.active && (
                              <span className="text-[11px] font-sans font-medium text-[#10B981]">
                                ACTIF
                              </span>
                            )}
                            <span
                              className={
                                s.direction === 'up'
                                  ? 'text-[#10B981]'
                                  : s.direction === 'down'
                                  ? 'text-[#EF4444]'
                                  : 'text-[#64748B]'
                              }
                            >
                              {s.rangePct}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* Unswept Levels Panel */}
                    <div className="px-4 py-2.5 border-t border-b border-[#1E293B] bg-[#0F1521] flex items-center justify-between">
                      <span className="text-xs font-semibold text-[#CBD5E1]">
                        Niveaux Non Balayes
                      </span>
                      <span className="text-xs font-mono tabular-nums text-[#94A3B8]">
                        {activeUnswept.length}
                      </span>
                    </div>

                    <div className="max-h-[210px] overflow-y-auto divide-y divide-[#1E293B]/50">
                      {activeUnswept.length === 0 ? (
                        <div className="px-4 py-5 text-xs text-[#64748B] text-center">
                          Tous les niveaux precedents ont ete balayes.
                        </div>
                      ) : (
                        activeUnswept
                          .slice(-10)
                          .reverse()
                          .map((lvl) => (
                            <div
                              key={lvl.id}
                              className="px-4 py-2 flex items-center justify-between text-xs"
                            >
                              <div className="flex items-center gap-2">
                                <span
                                  className="w-1.5 h-3 rounded-xs"
                                  style={{ backgroundColor: lvl.color }}
                                />
                                <span className="font-medium text-[#E2E8F0]">
                                  {lvl.shortName}.{lvl.isHigh ? 'H' : 'L'}
                                </span>
                                <span className="text-[#64748B]">{lvl.sessionName}</span>
                              </div>
                              <span className="font-mono tabular-nums font-medium text-[#F8FAFC]">
                                {lvl.level.toFixed(2)}
                              </span>
                            </div>
                          ))
                      )}
                    </div>
                  </aside>
                </section>

                <ConfluenceTable
                  alerts={snapshot.confluenceAlerts}
                  sweeps={snapshot.sweepEvents}
                  onTestWebhook={() => void handleTestWebhook()}
                  testingWebhook={testingWebhook}
                />
              </>
            )}

            {/* Killzones Full Table Tab */}
            {activeTab === 'killzones' && (
              <section className="bg-[#111827] border border-[#1E293B] rounded-lg overflow-hidden">
                <div className="px-5 py-4 border-b border-[#1E293B] flex items-center justify-between">
                  <div>
                    <h2 className="text-base font-semibold text-[#F1F5F9]">
                      Niveaux de Liquidite des Sessions Killzones (XAU/USD)
                    </h2>
                    <p className="text-xs text-[#94A3B8] mt-0.5">
                      Suivi complet des sommets (High) et creux (Low) generes a la cloture de chaque session.
                    </p>
                  </div>
                  <span className="text-xs font-mono tabular-nums text-[#94A3B8]">
                    {snapshot.unsweptLevels.length} niveaux suivis
                  </span>
                </div>
                <div className="overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-[#1E293B] text-[11px] font-medium text-[#64748B]">
                        <th className="py-2.5 px-5">Session</th>
                        <th className="py-2.5 px-5">Code</th>
                        <th className="py-2.5 px-5">Type</th>
                        <th className="py-2.5 px-5 text-right">Niveau Prix</th>
                        <th className="py-2.5 px-5">Etat</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1E293B]/60 text-xs">
                      {[...snapshot.unsweptLevels].reverse().map((lvl) => (
                        <tr key={lvl.id} className="hover:bg-[#1E293B]/35 transition-colors">
                          <td className="py-2.5 px-5 text-[#F1F5F9] font-medium">{lvl.sessionName}</td>
                          <td className="py-2.5 px-5 font-mono text-[#CBD5E1]">
                            {lvl.shortName}.{lvl.isHigh ? 'H' : 'L'}
                          </td>
                          <td className="py-2.5 px-5 text-[#94A3B8]">
                            {lvl.isHigh ? 'Sommet Session (BSL)' : 'Creux Session (SSL)'}
                          </td>
                          <td className="py-2.5 px-5 text-right font-mono tabular-nums text-[#F8FAFC]">
                            {lvl.level.toFixed(2)}
                          </td>
                          <td className="py-2.5 px-5">
                            <span className={lvl.swept ? 'text-[#64748B]' : 'text-[#10B981] font-medium'}>
                              {lvl.swept ? 'Balaye' : 'Non balaye'}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            )}

            {/* Alerts Full Tab */}
            {activeTab === 'alerts' && (
              <ConfluenceTable
                alerts={snapshot.confluenceAlerts}
                sweeps={snapshot.sweepEvents}
                onTestWebhook={() => void handleTestWebhook()}
                testingWebhook={testingWebhook}
              />
            )}

            {/* Settings Tab */}
            {activeTab === 'settings' && (
              <IntegrationSettings
                snapshot={snapshot}
                onSaveConfig={handleSaveConfig}
                onTestWebhook={handleTestWebhook}
              />
            )}
          </>
        ) : null}
      </main>
    </div>
  );
}
