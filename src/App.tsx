import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ConfluenceTable } from './components/ConfluenceTable';
import { IntegrationSettings } from './components/IntegrationSettings';
import { XauChart } from './components/XauChart';
import {
  formatSymbolPrice,
  type EngineSnapshot,
  type SupportedSymbol,
} from './engine/types';

type NavTab = 'terminal' | 'killzones' | 'alerts' | 'settings';
type RailTab = 'sessions' | 'params';

const PAIRS: SupportedSymbol[] = ['XAU/USD', 'EUR/USD'];

export default function App() {
  const [selectedSymbol, setSelectedSymbol] = useState<SupportedSymbol>('XAU/USD');
  const [snapshot, setSnapshot] = useState<EngineSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<NavTab>('terminal');
  const [railTab, setRailTab] = useState<RailTab>('sessions');
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [testingWebhook, setTestingWebhook] = useState<boolean>(false);
  const [acknowledgingId, setAcknowledgingId] = useState<string | null>(null);
  const [toastMsg, setToastMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const lastSoundedPendingRef = useRef<string>('');

  // Anti-veille state: Browser Wake Lock + 25s /api/health heartbeat
  const [antiSleepEnabled, setAntiSleepEnabled] = useState<boolean>(true);
  const [wakeLockActive, setWakeLockActive] = useState<boolean>(false);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);

  // Quick rail settings state
  const [railToken, setRailToken] = useState<string>('');
  const [railChatId, setRailChatId] = useState<string>('');
  const [railTolerance, setRailTolerance] = useState<number>(0.7);
  const [railSaving, setRailSaving] = useState<boolean>(false);

  // Connect to SSE & initial state for the currently selected symbol
  useEffect(() => {
    let eventSource: EventSource | null = null;
    let active = true;
    const encodedSym = encodeURIComponent(selectedSymbol);

    setLoading(true);
    setError(null);

    const init = async () => {
      try {
        const res = await fetch(`/api/state?symbol=${encodedSym}`);
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

      eventSource = new EventSource(`/api/stream?symbol=${encodedSym}`);
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
  }, [selectedSymbol]);

  // Anti-Veille: Screen Wake Lock + 25s server keep-alive heartbeat
  useEffect(() => {
    if (!antiSleepEnabled) {
      if (wakeLockRef.current) {
        void wakeLockRef.current.release().catch(() => {});
        wakeLockRef.current = null;
      }
      setWakeLockActive(false);
      return;
    }

    let cancelled = false;

    const acquireWakeLock = async () => {
      try {
        if ('wakeLock' in navigator && document.visibilityState === 'visible') {
          const sentinel = await navigator.wakeLock.request('screen');
          if (!cancelled) {
            wakeLockRef.current = sentinel;
            setWakeLockActive(true);
            sentinel.addEventListener('release', () => {
              if (!cancelled) setWakeLockActive(false);
            });
          } else {
            void sentinel.release().catch(() => {});
          }
        }
      } catch {
        if (!cancelled) setWakeLockActive(false);
      }
    };

    void acquireWakeLock();

    const handleVisibility = () => {
      if (document.visibilityState === 'visible' && antiSleepEnabled) {
        void acquireWakeLock();
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    const heartbeat = setInterval(() => {
      void fetch('/api/health', { cache: 'no-store' }).catch(() => {});
    }, 25000);

    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', handleVisibility);
      clearInterval(heartbeat);
      if (wakeLockRef.current) {
        void wakeLockRef.current.release().catch(() => {});
        wakeLockRef.current = null;
      }
      setWakeLockActive(false);
    };
  }, [antiSleepEnabled]);

  useEffect(() => {
    if (snapshot) {
      setRailChatId(snapshot.config.telegramChatId);
      setRailTolerance(snapshot.config.tolerance);
    }
  }, [snapshot?.config.telegramChatId, snapshot?.config.tolerance]);

  const showToast = useCallback((ok: boolean, text: string) => {
    setToastMsg({ ok, text });
    setTimeout(() => setToastMsg(null), 5000);
  }, []);

  const handleRefreshFeed = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch(`/api/feed/refresh?symbol=${encodeURIComponent(selectedSymbol)}`, {
        method: 'POST',
      });
      const data = (await res.json()) as { ok: boolean; snapshot?: EngineSnapshot };
      if (data.snapshot) setSnapshot(data.snapshot);
      showToast(true, `Flux reel ${selectedSymbol} synchronise.`);
    } catch (err) {
      showToast(false, err instanceof Error ? err.message : 'Echec synchronisation');
    } finally {
      setRefreshing(false);
    }
  }, [selectedSymbol, showToast]);

  const handleSaveConfig = useCallback(
    async (patch: Record<string, unknown>) => {
      const res = await fetch(`/api/config?symbol=${encodeURIComponent(selectedSymbol)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...patch, symbol: selectedSymbol }),
      });
      const data = (await res.json()) as { ok: boolean; snapshot?: EngineSnapshot; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? 'Echec de mise a jour');
      }
      if (data.snapshot) setSnapshot(data.snapshot);
    },
    [selectedSymbol]
  );

  const handleQuickSaveRail = async (e: React.FormEvent) => {
    e.preventDefault();
    setRailSaving(true);
    try {
      const payload: Record<string, unknown> = {
        telegramChatId: railChatId,
        tolerance: railTolerance,
      };
      if (railToken.trim().length > 0) {
        payload.telegramBotToken = railToken.trim();
      }
      await handleSaveConfig(payload);
      setRailToken('');
      showToast(true, 'Configuration Telegram et parametres enregistres.');
    } catch (err) {
      showToast(false, err instanceof Error ? err.message : 'Erreur sauvegarde');
    } finally {
      setRailSaving(false);
    }
  };

  const handleTestWebhook = useCallback(async () => {
    setTestingWebhook(true);
    try {
      const res = await fetch(`/api/webhook/test?symbol=${encodeURIComponent(selectedSymbol)}`, {
        method: 'POST',
      });
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
  }, [selectedSymbol, showToast]);

  const handleAcknowledgeAlert = useCallback(
    async (id: string) => {
      setAcknowledgingId(id);
      try {
        const res = await fetch(`/api/alerts/ack?symbol=${encodeURIComponent(selectedSymbol)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, symbol: selectedSymbol }),
        });
        const data = (await res.json()) as { ok: boolean; snapshot?: EngineSnapshot };
        if (data.snapshot) setSnapshot(data.snapshot);
        showToast(true, "Alerte validee (« J'ai vu »). Les rappels Telegram sont arretes.");
      } catch (err) {
        showToast(false, err instanceof Error ? err.message : 'Erreur validation');
      } finally {
        setAcknowledgingId(null);
      }
    },
    [selectedSymbol, showToast]
  );

  const handleAcknowledgeAll = useCallback(async () => {
    setAcknowledgingId('ALL');
    try {
      const res = await fetch(`/api/alerts/ack?symbol=${encodeURIComponent(selectedSymbol)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all: true, symbol: selectedSymbol }),
      });
      const data = (await res.json()) as { ok: boolean; snapshot?: EngineSnapshot };
      if (data.snapshot) setSnapshot(data.snapshot);
      showToast(true, 'Toutes les alertes en cours ont ete validees.');
    } catch (err) {
      showToast(false, err instanceof Error ? err.message : 'Erreur validation');
    } finally {
      setAcknowledgingId(null);
    }
  }, [selectedSymbol, showToast]);

  const pendingAlerts =
    snapshot?.confluenceAlerts.filter((a) => a.ackStatus === 'pending') ?? [];

  // Play subtle double-beep chime in browser when a new live pending alert arrives
  useEffect(() => {
    const newest = pendingAlerts[0];
    if (!newest) return;
    const key = `${newest.id}_${newest.reminderCount}`;
    if (lastSoundedPendingRef.current === key) return;
    lastSoundedPendingRef.current = key;

    try {
      const AudioCtx =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const now = ctx.currentTime;
      [0, 0.22].forEach((offset, idx) => {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.value = idx === 0 ? 784 : 988;
        gain.gain.setValueAtTime(0.08, now + offset);
        gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.16);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(now + offset);
        osc.stop(now + offset + 0.17);
      });
    } catch {
      // Ignore autoplay restriction
    }
  }, [pendingAlerts]);

  const latestCandle = snapshot?.candles[snapshot.candles.length - 1] ?? null;
  const activeUnswept = snapshot?.unsweptLevels.filter((l) => !l.swept) ?? [];
  const latestTrend = snapshot?.candleTrends[snapshot.candleTrends.length - 1] ?? 0;

  return (
    <div className="min-h-screen bg-[#0B0F17] text-[#F1F5F9] flex flex-col">
      {/* Top Bar Contract: 3 clean zones */}
      <header className="border-b border-[#1E293B] bg-[#0B0F17]">
        <div className="max-w-[1440px] mx-auto px-4 sm:px-6 py-3 flex flex-wrap md:flex-nowrap items-center justify-between gap-4 md:gap-8">
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

          <nav className="flex items-center gap-4 sm:gap-6">
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
                className={`text-xs sm:text-sm font-medium transition-colors whitespace-nowrap shrink-0 pb-0.5 border-b cursor-pointer ${
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
              className="px-3.5 py-2 text-xs font-medium bg-[#2563EB] hover:bg-[#1D4ED8] text-white rounded-md transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 cursor-pointer"
            >
              {testingWebhook ? 'Envoi...' : 'Tester Webhook'}
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1 max-w-[1440px] w-full mx-auto px-4 sm:px-6 py-6 flex flex-col gap-6">
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

        {/* Pair Switcher (XAU/USD & EUR/USD) + Anti-Veille Bar */}
        <section className="flex flex-wrap items-center justify-between gap-4 bg-[#111827] border border-[#1E293B] rounded-lg px-4 py-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-medium text-[#94A3B8] mr-1">Actifs surveilles (24/7 Telegram) :</span>
            <div className="flex items-center bg-[#0B0F17] border border-[#1E293B] rounded-md p-0.5 gap-1">
              {PAIRS.map((pair) => {
                const overview = snapshot?.symbolsOverview?.find((o) => o.symbol === pair);
                const isSelected = selectedSymbol === pair;
                return (
                  <button
                    key={pair}
                    type="button"
                    onClick={() => setSelectedSymbol(pair)}
                    className={`px-3 py-1.5 text-xs font-medium rounded transition-colors flex items-center gap-2 cursor-pointer whitespace-nowrap ${
                      isSelected
                        ? 'bg-[#2563EB] text-white'
                        : 'text-[#CBD5E1] hover:bg-[#1E293B]/60'
                    }`}
                  >
                    <span className="font-semibold">{pair}</span>
                    {overview?.price !== null && overview?.price !== undefined && (
                      <span
                        className={`font-mono tabular-nums ${
                          isSelected ? 'text-white/90' : 'text-[#94A3B8]'
                        }`}
                      >
                        {formatSymbolPrice(overview.price, pair)}
                      </span>
                    )}
                    {overview && (
                      <span
                        className={`text-[10px] font-mono ${
                          isSelected
                            ? 'text-white/80'
                            : overview.dailyBias === overview.h4Bias && overview.dailyBias !== 'NEUTRAL'
                            ? overview.dailyBias === 'BULLISH'
                              ? 'text-[#10B981]'
                              : 'text-[#EF4444]'
                            : 'text-[#64748B]'
                        }`}
                      >
                        D1:{overview.dailyBias === 'BULLISH' ? '▲' : overview.dailyBias === 'BEARISH' ? '▼' : '-'}
                      </span>
                    )}
                    {overview && (overview.pendingAckCount ?? 0) > 0 && (
                      <span className="text-[10px] font-mono font-semibold text-[#F59E0B]">
                        ({overview.pendingAckCount} EN COURS)
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setAntiSleepEnabled((v) => !v)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors flex items-center gap-2 cursor-pointer whitespace-nowrap ${
                antiSleepEnabled
                  ? 'bg-[#10B981]/10 border-[#10B981]/40 text-[#10B981]'
                  : 'bg-[#0B0F17] border-[#1E293B] text-[#94A3B8]'
              }`}
              title="Maintient l'ecran actif (Wake Lock) et envoie un ping serveur toutes les 25s"
            >
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  antiSleepEnabled ? 'bg-[#10B981]' : 'bg-[#64748B]'
                }`}
              />
              <span>
                {antiSleepEnabled
                  ? wakeLockActive
                    ? 'Anti-Veille Actif (WakeLock + Ping)'
                    : 'Anti-Veille Actif (Heartbeat 25s)'
                  : 'Anti-Veille Desactive'}
              </span>
            </button>
          </div>
        </section>

        {pendingAlerts.length > 0 && (
          <section className="bg-[#111827] border border-[#F59E0B]/70 rounded-lg p-4 flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5">
                <span className="w-2.5 h-2.5 rounded-full bg-[#F59E0B]" />
                <span className="text-sm font-semibold text-[#FBBF24]">
                  ALERTE EN COURS — VALIDATION « J'AI VU » REQUISE ({pendingAlerts.length})
                </span>
              </div>
              {pendingAlerts.length > 1 && (
                <button
                  type="button"
                  onClick={() => void handleAcknowledgeAll()}
                  disabled={acknowledgingId === 'ALL'}
                  className="px-3.5 py-1.5 text-xs font-semibold bg-[#10B981] hover:bg-[#059669] text-[#0B0F17] rounded-md transition-colors cursor-pointer disabled:opacity-50"
                >
                  {acknowledgingId === 'ALL' ? 'Validation...' : 'Tout valider (J’ai vu)'}
                </button>
              )}
            </div>

            <div className="divide-y divide-[#1E293B]">
              {pendingAlerts.map((a) => (
                <div
                  key={a.id}
                  className="py-2.5 flex flex-wrap items-center justify-between gap-4 text-xs"
                >
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="font-semibold text-[#F8FAFC]">{a.symbol} M3</span>
                    <span
                      className={`font-semibold ${
                        a.direction === 'BULLISH' ? 'text-[#10B981]' : 'text-[#EF4444]'
                      }`}
                    >
                      {a.direction === 'BULLISH' ? '▲ HAUSSIER' : '▼ BAISSIER'}
                    </span>
                    <span className="text-[#CBD5E1]">
                      Cassure {a.kzSweep.sessionName} ({a.kzSweep.shortName}.
                      {a.kzSweep.isHigh ? 'H' : 'L'}{' '}
                      <span className="font-mono tabular-nums">
                        {formatSymbolPrice(a.kzSweep.level, a.symbol)}
                      </span>
                      )
                    </span>
                    <span className="font-mono tabular-nums text-[#F59E0B]">
                      Rappel Telegram #{a.reminderCount} envoye (repete toutes les{' '}
                      {snapshot?.config.repeatAlertIntervalSec ?? 30}s jusqu'a validation)
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={() => void handleAcknowledgeAlert(a.id)}
                    disabled={acknowledgingId === a.id}
                    className="px-4 py-2 text-xs font-semibold bg-[#10B981] hover:bg-[#059669] text-[#0B0F17] rounded-md transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap"
                  >
                    {acknowledgingId === a.id ? 'Validation...' : "Valider (J'ai vu)"}
                  </button>
                </div>
              ))}
            </div>
          </section>
        )}

        {loading && !snapshot ? (
          <div className="bg-[#111827] border border-[#1E293B] rounded-lg p-10 text-center">
            <p className="text-sm text-[#94A3B8]">
              Connexion aux donnees reelles {selectedSymbol} M3 et calcul des sessions Killzones...
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
                  <span>{selectedSymbol} Spot</span>
                  <span aria-hidden="true">·</span>
                  <span>M3 Reel</span>
                </div>
                <div className="mt-1.5 flex items-baseline justify-between gap-2">
                  <span className="text-xl font-semibold font-mono tabular-nums text-[#F8FAFC]">
                    {latestCandle ? formatSymbolPrice(latestCandle.close, selectedSymbol) : '-'}
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
                  <span>Biais HTF ({selectedSymbol})</span>
                  <span aria-hidden="true">·</span>
                  <span>Daily + H4</span>
                </div>
                <div className="mt-1.5 flex items-baseline justify-between gap-2">
                  <span
                    className={`text-sm font-semibold whitespace-nowrap ${
                      snapshot.htfBias.alignedDirection === 'BULLISH'
                        ? 'text-[#10B981]'
                        : snapshot.htfBias.alignedDirection === 'BEARISH'
                        ? 'text-[#EF4444]'
                        : 'text-[#F59E0B]'
                    }`}
                  >
                    {snapshot.htfBias.alignedDirection === 'BULLISH'
                      ? 'HAUSSIER (D1+H4)'
                      : snapshot.htfBias.alignedDirection === 'BEARISH'
                      ? 'BAISSIER (D1+H4)'
                      : `D1 ${snapshot.htfBias.daily === 'BULLISH' ? 'H' : 'B'} / H4 ${
                          snapshot.htfBias.h4 === 'BULLISH' ? 'H' : 'B'
                        }`}
                  </span>
                  <span className="text-xs font-mono tabular-nums text-[#94A3B8]">
                    {snapshot.confluenceAlerts.filter((a) => a.probability === 'HIGH').length} haute prob.
                  </span>
                </div>
              </div>

              <div className="bg-[#111827] border border-[#1E293B] rounded-lg px-4 py-3.5">
                <div className="text-xs text-[#94A3B8] flex items-center gap-1.5">
                  <span>Confluences</span>
                  <span aria-hidden="true">·</span>
                  <span>Telegram</span>
                </div>
                <div className="mt-1.5 flex items-baseline justify-between gap-2">
                  <span className="text-xl font-semibold font-mono tabular-nums text-[#F8FAFC]">
                    {snapshot.confluenceAlerts.length}
                  </span>
                  <button
                    type="button"
                    onClick={() => setActiveTab('settings')}
                    className={`text-xs font-medium underline-offset-2 hover:underline cursor-pointer ${
                      snapshot.config.hasTelegramToken && snapshot.config.alertsEnabled
                        ? 'text-[#10B981]'
                        : 'text-[#94A3B8]'
                    }`}
                  >
                    {snapshot.config.hasTelegramToken && snapshot.config.alertsEnabled
                      ? `Bot actif (${snapshot.config.telegramChatId})`
                      : 'Configurer Telegram'}
                  </button>
                </div>
              </div>
            </section>

            {/* Terminal View */}
            {activeTab === 'terminal' && (
              <>
                <section className="grid grid-cols-1 xl:grid-cols-[1fr_340px] gap-6 items-start">
                  <XauChart
                    symbol={selectedSymbol}
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
                    onOpenSettings={() => setRailTab('params')}
                  />

                  {/* Right Rail: Switchable between Sessions Killzones & Quick Telegram/Indicator Settings */}
                  <aside className="bg-[#111827] border border-[#1E293B] rounded-lg overflow-hidden flex flex-col">
                    <div className="px-3 py-2.5 border-b border-[#1E293B] flex items-center justify-between gap-2">
                      <div className="flex items-center bg-[#0B0F17] border border-[#1E293B] rounded-md p-0.5 w-full">
                        <button
                          type="button"
                          onClick={() => setRailTab('sessions')}
                          className={`flex-1 py-1.5 text-xs font-medium rounded transition-colors cursor-pointer ${
                            railTab === 'sessions'
                              ? 'bg-[#1E293B] text-[#F8FAFC]'
                              : 'text-[#64748B] hover:text-[#CBD5E1]'
                          }`}
                        >
                          Killzones & Niveaux
                        </button>
                        <button
                          type="button"
                          onClick={() => setRailTab('params')}
                          className={`flex-1 py-1.5 text-xs font-medium rounded transition-colors cursor-pointer ${
                            railTab === 'params'
                              ? 'bg-[#1E293B] text-[#F8FAFC]'
                              : 'text-[#64748B] hover:text-[#CBD5E1]'
                          }`}
                        >
                          Parametres & Telegram
                        </button>
                      </div>
                    </div>

                    {railTab === 'sessions' ? (
                      <>
                        <div className="px-4 py-2.5 border-b border-[#1E293B] bg-[#0F1521] flex items-center justify-between text-xs">
                          <span className="text-[#94A3B8]">
                            NY ({snapshot.countdown.nyTimezone} {snapshot.countdown.isDst ? 'EDT' : 'EST'})
                          </span>
                          <span className="font-mono tabular-nums text-[#E2E8F0]">
                            {snapshot.countdown.nyTimeFormatted}
                          </span>
                        </div>

                        <div className="px-4 py-2.5 border-b border-[#1E293B] flex items-center justify-between text-xs">
                          <span className="text-[#94A3B8]">Biais D1 / H4 ({selectedSymbol})</span>
                          <div className="flex items-center gap-2 font-medium">
                            <span
                              className={
                                snapshot.htfBias.daily === 'BULLISH'
                                  ? 'text-[#10B981]'
                                  : snapshot.htfBias.daily === 'BEARISH'
                                  ? 'text-[#EF4444]'
                                  : 'text-[#64748B]'
                              }
                            >
                              D1 {snapshot.htfBias.daily === 'BULLISH' ? '▲' : snapshot.htfBias.daily === 'BEARISH' ? '▼' : '-'}
                            </span>
                            <span className="text-[#475569]">/</span>
                            <span
                              className={
                                snapshot.htfBias.h4 === 'BULLISH'
                                  ? 'text-[#10B981]'
                                  : snapshot.htfBias.h4 === 'BEARISH'
                                  ? 'text-[#EF4444]'
                                  : 'text-[#64748B]'
                              }
                            >
                              H4 {snapshot.htfBias.h4 === 'BULLISH' ? '▲' : snapshot.htfBias.h4 === 'BEARISH' ? '▼' : '-'}
                            </span>
                          </div>
                        </div>

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
                                    {formatSymbolPrice(lvl.level, selectedSymbol)}
                                  </span>
                                </div>
                              ))
                          )}
                        </div>
                      </>
                    ) : (
                      <form onSubmit={handleQuickSaveRail} className="p-4 flex flex-col gap-4 text-xs">
                        <label className="flex flex-col gap-1.5">
                          <div className="flex items-center justify-between">
                            <span className="text-[#CBD5E1] font-medium">Bot Token Telegram</span>
                            {snapshot.config.hasTelegramToken && (
                              <span className="font-mono text-[11px] text-[#10B981]">
                                {snapshot.config.telegramTokenMasked}
                              </span>
                            )}
                          </div>
                          <input
                            type="password"
                            value={railToken}
                            onChange={(e) => setRailToken(e.target.value)}
                            placeholder={
                              snapshot.config.hasTelegramToken
                                ? 'Laisser vide pour garder actuel'
                                : 'Coller token @BotFather'
                            }
                            className="bg-[#0B0F17] border border-[#1E293B] rounded-md px-3 py-2 text-xs font-mono text-[#F1F5F9] focus:outline-none focus:border-[#2563EB]"
                          />
                        </label>

                        <label className="flex flex-col gap-1.5">
                          <span className="text-[#CBD5E1] font-medium">Telegram Chat ID</span>
                          <input
                            type="text"
                            value={railChatId}
                            onChange={(e) => setRailChatId(e.target.value)}
                            placeholder="8755686322"
                            className="bg-[#0B0F17] border border-[#1E293B] rounded-md px-3 py-2 text-xs font-mono tabular-nums text-[#F1F5F9] focus:outline-none focus:border-[#2563EB]"
                          />
                        </label>

                        <label className="flex flex-col gap-1.5">
                          <span className="text-[#CBD5E1] font-medium">
                            Filtre bruit CISD ({railTolerance.toFixed(1)})
                          </span>
                          <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.1}
                            value={railTolerance}
                            onChange={(e) => setRailTolerance(Number.parseFloat(e.target.value))}
                            className="accent-[#2563EB]"
                          />
                        </label>

                        <div className="flex items-center justify-between gap-2 pt-1">
                          <span className="text-[#94A3B8]">Killzone Active</span>
                          <button
                            type="button"
                            onClick={() =>
                              void handleSaveConfig({
                                requireActiveKillzone: !snapshot.config.requireActiveKillzone,
                              })
                            }
                            className={`px-2.5 py-1 rounded border cursor-pointer ${
                              snapshot.config.requireActiveKillzone
                                ? 'bg-[#10B981]/15 border-[#10B981]/50 text-[#10B981]'
                                : 'bg-[#0B0F17] border-[#1E293B] text-[#94A3B8]'
                            }`}
                          >
                            {snapshot.config.requireActiveKillzone ? 'Oui' : 'Non'}
                          </button>
                        </div>

                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[#94A3B8]">Intrabar avant reintegration</span>
                          <button
                            type="button"
                            onClick={() =>
                              void handleSaveConfig({
                                triggerOnIntrabar: !snapshot.config.triggerOnIntrabar,
                              })
                            }
                            className={`px-2.5 py-1 rounded border cursor-pointer ${
                              snapshot.config.triggerOnIntrabar
                                ? 'bg-[#10B981]/15 border-[#10B981]/50 text-[#10B981]'
                                : 'bg-[#0B0F17] border-[#1E293B] text-[#94A3B8]'
                            }`}
                          >
                            {snapshot.config.triggerOnIntrabar ? 'Oui' : 'Non'}
                          </button>
                        </div>

                        <div className="flex flex-col gap-2 pt-2 border-t border-[#1E293B]">
                          <button
                            type="submit"
                            disabled={railSaving}
                            className="w-full py-2 text-xs font-medium bg-[#2563EB] hover:bg-[#1D4ED8] text-white rounded-md transition-colors cursor-pointer disabled:opacity-50"
                          >
                            {railSaving ? 'Enregistrement...' : 'Enregistrer'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setActiveTab('settings')}
                            className="w-full py-1.5 text-xs text-[#94A3B8] hover:text-[#F1F5F9] transition-colors cursor-pointer"
                          >
                            Ouvrir tous les parametres avances
                          </button>
                        </div>
                      </form>
                    )}
                  </aside>
                </section>

                <ConfluenceTable
                  symbol={selectedSymbol}
                  alerts={snapshot.confluenceAlerts}
                  sweeps={snapshot.sweepEvents}
                  onTestWebhook={() => void handleTestWebhook()}
                  testingWebhook={testingWebhook}
                  onAcknowledgeAlert={handleAcknowledgeAlert}
                  acknowledgingId={acknowledgingId}
                />

                {/* Full Settings Section also visible directly on Terminal */}
                <section className="pt-2">
                  <IntegrationSettings
                    snapshot={snapshot}
                    onSaveConfig={handleSaveConfig}
                    onTestWebhook={handleTestWebhook}
                  />
                </section>
              </>
            )}

            {/* Killzones Full Table Tab */}
            {activeTab === 'killzones' && (
              <section className="bg-[#111827] border border-[#1E293B] rounded-lg overflow-hidden">
                <div className="px-5 py-4 border-b border-[#1E293B] flex items-center justify-between">
                  <div>
                    <h2 className="text-base font-semibold text-[#F1F5F9]">
                      Niveaux de Liquidite des Sessions Killzones ({selectedSymbol})
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
                            {formatSymbolPrice(lvl.level, selectedSymbol)}
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
                symbol={selectedSymbol}
                alerts={snapshot.confluenceAlerts}
                sweeps={snapshot.sweepEvents}
                onTestWebhook={() => void handleTestWebhook()}
                testingWebhook={testingWebhook}
                onAcknowledgeAlert={handleAcknowledgeAlert}
                acknowledgingId={acknowledgingId}
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
