import React, { useEffect, useState } from 'react';
import type { EngineSnapshot, HtfBiasMode, TimezoneMode } from '../engine/types';

interface IntegrationSettingsProps {
  snapshot: EngineSnapshot;
  onSaveConfig: (patch: Record<string, unknown>) => Promise<void>;
  onTestWebhook: () => Promise<{ ok: boolean; detail: string }>;
}

export const IntegrationSettings: React.FC<IntegrationSettingsProps> = ({
  snapshot,
  onSaveConfig,
  onTestWebhook,
}) => {
  const { config, feedStatus } = snapshot;

  const [tzMode, setTzMode] = useState<TimezoneMode>(config.tzMode);
  const [tolerance, setTolerance] = useState<number>(config.tolerance);
  const [swingPeriod, setSwingPeriod] = useState<number>(config.swingPeriod);
  const [expiryBars, setExpiryBars] = useState<number>(config.expiryBars);
  const [liquidityLookback, setLiquidityLookback] = useState<number>(config.liquidityLookback);
  const [kzLookbackBars, setKzLookbackBars] = useState<number>(config.kzLookbackBars);
  const [requireActiveKillzone, setRequireActiveKillzone] = useState<boolean>(
    config.requireActiveKillzone
  );
  const [triggerOnIntrabar, setTriggerOnIntrabar] = useState<boolean>(config.triggerOnIntrabar);
  const [dailyBiasMode, setDailyBiasMode] = useState<HtfBiasMode>(config.dailyBiasMode);
  const [h4BiasMode, setH4BiasMode] = useState<HtfBiasMode>(config.h4BiasMode);
  const [enableM5Cisd, setEnableM5Cisd] = useState<boolean>(config.enableM5Cisd ?? true);
  const [telegramBotToken, setTelegramBotToken] = useState<string>('');
  const [showToken, setShowToken] = useState<boolean>(false);
  const [telegramChatId, setTelegramChatId] = useState<string>(config.telegramChatId);
  const [customWebhookUrl, setCustomWebhookUrl] = useState<string>(config.customWebhookUrl);
  const [alertsEnabled, setAlertsEnabled] = useState<boolean>(config.alertsEnabled);
  const [liveSetupMaxMinutes, setLiveSetupMaxMinutes] = useState<number>(
    config.liveSetupMaxMinutes ?? 20
  );
  const [repeatAlertIntervalSec, setRepeatAlertIntervalSec] = useState<number>(
    config.repeatAlertIntervalSec ?? 30
  );

  const [saving, setSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testFeedback, setTestFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [copiedHealth, setCopiedHealth] = useState(false);

  const healthUrl = `${
    (snapshot.appUrl && snapshot.appUrl.trim()) ||
    (typeof window !== 'undefined' ? window.location.origin : '')
  }/api/health`;

  const handleCopyHealth = async () => {
    try {
      await navigator.clipboard.writeText(healthUrl);
      setCopiedHealth(true);
      setTimeout(() => setCopiedHealth(false), 2500);
    } catch {
      // Ignore clipboard failure in restricted context
    }
  };

  useEffect(() => {
    setTzMode(config.tzMode);
    setTolerance(config.tolerance);
    setSwingPeriod(config.swingPeriod);
    setExpiryBars(config.expiryBars);
    setLiquidityLookback(config.liquidityLookback);
    setKzLookbackBars(config.kzLookbackBars);
    setRequireActiveKillzone(config.requireActiveKillzone);
    setTriggerOnIntrabar(config.triggerOnIntrabar);
    setDailyBiasMode(config.dailyBiasMode);
    setH4BiasMode(config.h4BiasMode);
    setEnableM5Cisd(config.enableM5Cisd ?? true);
    setTelegramChatId(config.telegramChatId);
    setCustomWebhookUrl(config.customWebhookUrl);
    setAlertsEnabled(config.alertsEnabled);
    setLiveSetupMaxMinutes(config.liveSetupMaxMinutes ?? 20);
    setRepeatAlertIntervalSec(config.repeatAlertIntervalSec ?? 30);
  }, [config]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setSaveFeedback(null);
    try {
      const payload: Record<string, unknown> = {
        tzMode,
        tolerance,
        swingPeriod,
        expiryBars,
        liquidityLookback,
        kzLookbackBars,
        requireActiveKillzone,
        triggerOnIntrabar,
        dailyBiasMode,
        h4BiasMode,
        highProbabilityOnly: false,
        enableM5Cisd,
        telegramChatId,
        customWebhookUrl,
        alertsEnabled,
        liveSetupMaxMinutes,
        repeatAlertIntervalSec,
      };
      if (telegramBotToken.trim().length > 0) {
        payload.telegramBotToken = telegramBotToken.trim();
      }
      await onSaveConfig(payload);
      setTelegramBotToken('');
      setSaveFeedback('Configuration Telegram et parametres enregistres sur le serveur.');
    } catch (err) {
      setSaveFeedback(err instanceof Error ? err.message : 'Erreur de sauvegarde');
    } finally {
      setSaving(false);
    }
  };

  const handleTest = async () => {
    setTesting(true);
    setTestFeedback(null);
    try {
      const res = await onTestWebhook();
      setTestFeedback({ ok: res.ok, text: res.detail });
    } catch (err) {
      setTestFeedback({ ok: false, text: err instanceof Error ? err.message : 'Echec test' });
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      {/* Left: Indicator & Confluence Parameters */}
      <form
        onSubmit={handleSave}
        className="bg-[#111827] border border-[#1E293B] rounded-lg p-5 flex flex-col gap-5"
      >
        <div>
          <h2 className="text-base font-semibold text-[#F1F5F9]">
            Parametres Killzones ICT et CISD M3 / M5
          </h2>
          <p className="mt-1 text-xs text-[#94A3B8]">
            Les moteurs XAU/USD et EUR/USD surveillent en parallele. Daily et H4 sont analyses separement : ils peuvent etre divergents.
          </p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="flex flex-col gap-1.5 text-xs">
            <span className="text-[#CBD5E1] font-medium">Fuseau New York (DST)</span>
            <select
              value={tzMode}
              onChange={(e) => setTzMode(e.target.value as TimezoneMode)}
              className="bg-[#0B0F17] border border-[#1E293B] rounded-md px-3 py-2 text-sm text-[#F1F5F9] focus:outline-none focus:border-[#2563EB]"
            >
              <option value="Auto (DST)">Auto (DST) — EDT/EST</option>
              <option value="Manual UTC-4 (EDT)">Manual UTC-4 (EDT)</option>
              <option value="Manual UTC-5 (EST)">Manual UTC-5 (EST)</option>
            </select>
          </label>

          <label className="flex flex-col gap-1.5 text-xs">
            <span className="text-[#CBD5E1] font-medium">
              Noise Filter CISD (tolerence : {tolerance.toFixed(1)})
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.1}
              value={tolerance}
              onChange={(e) => setTolerance(Number.parseFloat(e.target.value))}
              className="mt-2 accent-[#2563EB]"
            />
          </label>

          <label className="flex flex-col gap-1.5 text-xs">
            <span className="text-[#CBD5E1] font-medium">Swing Period (len M3)</span>
            <input
              type="number"
              min={3}
              max={50}
              value={swingPeriod}
              onChange={(e) => setSwingPeriod(Number.parseInt(e.target.value, 10) || 12)}
              className="bg-[#0B0F17] border border-[#1E293B] rounded-md px-3 py-2 text-sm font-mono tabular-nums text-[#F1F5F9] focus:outline-none focus:border-[#2563EB]"
            />
          </label>

          <label className="flex flex-col gap-1.5 text-xs">
            <span className="text-[#CBD5E1] font-medium">Expiry Bars (M3)</span>
            <input
              type="number"
              min={20}
              max={500}
              value={expiryBars}
              onChange={(e) => setExpiryBars(Number.parseInt(e.target.value, 10) || 100)}
              className="bg-[#0B0F17] border border-[#1E293B] rounded-md px-3 py-2 text-sm font-mono tabular-nums text-[#F1F5F9] focus:outline-none focus:border-[#2563EB]"
            />
          </label>

          <label className="flex flex-col gap-1.5 text-xs">
            <span className="text-[#CBD5E1] font-medium">Liquidity Lookback Swing (M3)</span>
            <input
              type="number"
              min={1}
              max={50}
              value={liquidityLookback}
              onChange={(e) => setLiquidityLookback(Number.parseInt(e.target.value, 10) || 10)}
              className="bg-[#0B0F17] border border-[#1E293B] rounded-md px-3 py-2 text-sm font-mono tabular-nums text-[#F1F5F9] focus:outline-none focus:border-[#2563EB]"
            />
          </label>

        </div>

        <div className="pt-2 border-t border-[#1E293B] flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <span className="text-sm font-medium text-[#F1F5F9]">Detection CISD M5 en complement du M3</span>
              <p className="text-xs text-[#94A3B8]">Moteur M5 independant, calcule depuis les bougies 1 minute du flux Yahoo. Les deux timeframes peuvent produire leurs propres alertes.</p>
            </div>
            <button type="button" onClick={() => setEnableM5Cisd((v) => !v)} className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors shrink-0 cursor-pointer ${enableM5Cisd ? 'bg-[#10B981]/15 border-[#10B981]/50 text-[#10B981]' : 'bg-[#0B0F17] border-[#1E293B] text-[#94A3B8]'}`}>
              {enableM5Cisd ? 'M5 active' : 'M5 desactive'}
            </button>
          </div>
          <div className="rounded-md border border-[#1E293B] bg-[#0B0F17] p-3">
            <span className="text-sm font-medium text-[#F1F5F9]">Surveillance apres sweep — jusqu'a la cloture NY</span>
            <p className="mt-1 text-xs leading-relaxed text-[#94A3B8]">
              Le sweep initial doit se produire dans une Killzone (Asia, London, NY AM ou NY PM). Apres ce sweep, le moteur continue de chercher un CISD M3/M5, meme apres la fin de la Killzone et apres un retest ou une reintegration, jusqu'a 23:59 heure de New York. Le Daily et le H4 servent a classer la probabilite, pas a bloquer les alertes divergentes.
            </p>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <span className="text-sm font-medium text-[#F1F5F9]">Detection immediate avant reintegration</span>
              <p className="text-xs text-[#94A3B8]">
                Alerte en temps reel intrabar M3 et M5 des qu'il y a cassure + CISD, sans attendre le retour dans le range.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setTriggerOnIntrabar((v) => !v)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors shrink-0 cursor-pointer ${
                triggerOnIntrabar
                  ? 'bg-[#10B981]/15 border-[#10B981]/50 text-[#10B981]'
                  : 'bg-[#0B0F17] border-[#1E293B] text-[#94A3B8]'
              }`}
            >
              {triggerOnIntrabar ? 'Temps reel Intrabar' : 'Cloture M3 seule'}
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="flex flex-col gap-1.5 text-xs">
              <span className="text-[#CBD5E1] font-medium">Biais Daily (D1)</span>
              <select
                value={dailyBiasMode}
                onChange={(e) => setDailyBiasMode(e.target.value as HtfBiasMode)}
                className="bg-[#0B0F17] border border-[#1E293B] rounded-md px-3 py-2 text-sm text-[#F1F5F9] focus:outline-none focus:border-[#2563EB]"
              >
                <option value="AUTO">Auto CISD D1 ({snapshot.htfBias.daily})</option>
                <option value="BULLISH">Manuel : HAUSSIER</option>
                <option value="BEARISH">Manuel : BAISSIER</option>
              </select>
            </label>

            <label className="flex flex-col gap-1.5 text-xs">
              <span className="text-[#CBD5E1] font-medium">Biais 4 Heures (H4)</span>
              <select
                value={h4BiasMode}
                onChange={(e) => setH4BiasMode(e.target.value as HtfBiasMode)}
                className="bg-[#0B0F17] border border-[#1E293B] rounded-md px-3 py-2 text-sm text-[#F1F5F9] focus:outline-none focus:border-[#2563EB]"
              >
                <option value="AUTO">Auto CISD H4 ({snapshot.htfBias.h4})</option>
                <option value="BULLISH">Manuel : HAUSSIER</option>
                <option value="BEARISH">Manuel : BAISSIER</option>
              </select>
            </label>
          </div>

          <div className="flex items-center justify-between gap-4 rounded-md border border-[#1E293B] bg-[#0B0F17] px-3 py-3">
            <div>
              <span className="text-sm font-medium text-[#F1F5F9]">Classement automatique Daily / H4</span>
              <p className="text-xs text-[#94A3B8] mt-1">
                Daily et H4 alignes dans le sens du CISD = HAUTE PROBABILITE. S'ils divergent ou sont contre le CISD, le signal reste alerte dans la Killzone avec son classement MEDIUM ou CONTRE-TENDANCE.
              </p>
            </div>
            <span className="px-3 py-1.5 text-xs font-semibold rounded-md border border-[#10B981]/50 bg-[#10B981]/15 text-[#10B981] shrink-0">AUTO</span>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <span className="text-sm font-medium text-[#F1F5F9]">Rappels Telegram jusqu’a validation</span>
              <p className="text-xs text-[#94A3B8]">
                Un message initial, puis un rappel selon l’intervalle choisi. Le bouton « J'ai vu » arrete immediatement les rappels.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setAlertsEnabled((v) => !v)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors shrink-0 cursor-pointer ${
                alertsEnabled
                  ? 'bg-[#10B981]/15 border-[#10B981]/50 text-[#10B981]'
                  : 'bg-[#0B0F17] border-[#1E293B] text-[#94A3B8]'
              }`}
            >
              {alertsEnabled ? 'Activees' : 'Desactivees'}
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="flex flex-col gap-1.5 text-xs">
              <span className="text-[#CBD5E1] font-medium">Intervalle des rappels Telegram (secondes)</span>
              <input
                type="number"
                min={10}
                max={300}
                value={repeatAlertIntervalSec}
                onChange={(e) =>
                  setRepeatAlertIntervalSec(Math.min(300, Math.max(10, Number.parseInt(e.target.value, 10) || 30)))
                }
                className="bg-[#0B0F17] border border-[#1E293B] rounded-md px-3 py-2 text-sm font-mono tabular-nums text-[#F1F5F9] focus:outline-none focus:border-[#2563EB]"
              />
              <span className="text-[#64748B]">Maximum 10 notifications par signal, rappels compris.</span>
            </label>

            <label className="flex flex-col gap-1.5 text-xs">
              <span className="text-[#CBD5E1] font-medium">Duree max « En cours » (min)</span>
              <input
                type="number"
                min={5}
                max={120}
                value={liveSetupMaxMinutes}
                onChange={(e) =>
                  setLiveSetupMaxMinutes(Math.max(5, Number.parseInt(e.target.value, 10) || 20))
                }
                className="bg-[#0B0F17] border border-[#1E293B] rounded-md px-3 py-2 text-sm font-mono tabular-nums text-[#F1F5F9] focus:outline-none focus:border-[#2563EB]"
              />
            </label>
          </div>
          <p className="text-xs text-[#94A3B8]">Telegram renvoie le signal a l'intervalle choisi jusqu'a « J'ai vu », a 10 notifications au total ou a l'expiration du setup.</p>

          <div className="grid grid-cols-1 gap-4">
            <label className="flex flex-col gap-1.5 text-xs">
              <div className="flex items-center justify-between">
                <span className="text-[#CBD5E1] font-medium">
                  Bot Token Telegram (@BotFather)
                </span>
                {config.hasTelegramToken && (
                  <span className="font-mono text-[11px] text-[#10B981]">
                    Actif : {config.telegramTokenMasked}
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <input
                  type={showToken ? 'text' : 'password'}
                  value={telegramBotToken}
                  onChange={(e) => setTelegramBotToken(e.target.value)}
                  placeholder={
                    config.hasTelegramToken
                      ? 'Laisser vide pour conserver le token enregistre, ou coller un nouveau'
                      : 'Ex: 8683387578:AAG9phaBO...'
                  }
                  className="flex-1 bg-[#0B0F17] border border-[#1E293B] rounded-md px-3 py-2 text-sm font-mono text-[#F1F5F9] focus:outline-none focus:border-[#2563EB]"
                />
                <button
                  type="button"
                  onClick={() => setShowToken((v) => !v)}
                  className="px-3 py-2 text-xs bg-[#0B0F17] border border-[#1E293B] hover:border-[#334155] text-[#CBD5E1] rounded-md whitespace-nowrap cursor-pointer"
                >
                  {showToken ? 'Masquer' : 'Afficher'}
                </button>
              </div>
            </label>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="flex flex-col gap-1.5 text-xs">
                <span className="text-[#CBD5E1] font-medium">Telegram Chat ID</span>
                <input
                  type="text"
                  value={telegramChatId}
                  onChange={(e) => setTelegramChatId(e.target.value)}
                  placeholder="8755686322"
                  className="bg-[#0B0F17] border border-[#1E293B] rounded-md px-3 py-2 text-sm font-mono tabular-nums text-[#F1F5F9] focus:outline-none focus:border-[#2563EB]"
                />
              </label>

              <label className="flex flex-col gap-1.5 text-xs">
                <span className="text-[#CBD5E1] font-medium">Webhook JSON externe (optionnel)</span>
                <input
                  type="url"
                  value={customWebhookUrl}
                  onChange={(e) => setCustomWebhookUrl(e.target.value)}
                  placeholder="https://..."
                  className="bg-[#0B0F17] border border-[#1E293B] rounded-md px-3 py-2 text-sm font-mono text-[#F1F5F9] focus:outline-none focus:border-[#2563EB]"
                />
              </label>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2">
          <div className="text-xs text-[#94A3B8]">
            {saveFeedback && <span className="text-[#10B981]">{saveFeedback}</span>}
          </div>
          <button
            type="submit"
            disabled={saving}
            className="px-4 py-2 text-xs font-medium bg-[#2563EB] hover:bg-[#1D4ED8] text-white rounded-md transition-colors cursor-pointer disabled:opacity-50"
          >
            {saving ? 'Enregistrement...' : 'Enregistrer la configuration'}
          </button>
        </div>
      </form>

      {/* Right: Live XAU/USD Feed & Telegram Verification */}
      <div className="bg-[#111827] border border-[#1E293B] rounded-lg p-5 flex flex-col gap-5">
        <div>
          <h2 className="text-base font-semibold text-[#F1F5F9]">
            Connectivite Donnees Reelles {config.symbol} et Bot Telegram
          </h2>
          <p className="mt-1 text-xs text-[#94A3B8]">
            Etat du flux temps reel (XAU/USD + EUR/USD actifs en simultane) et verification Telegram.
          </p>
        </div>

        <div className="border-t border-[#1E293B] divide-y divide-[#1E293B]/60 text-xs">
          <div className="py-3 flex items-center justify-between gap-4">
            <span className="text-[#94A3B8]">Symbole affiche</span>
            <span className="font-mono font-medium text-[#F1F5F9]">{config.symbol} · M3 / M5</span>
          </div>
          <div className="py-3 flex items-center justify-between gap-4">
            <span className="text-[#94A3B8]">Source de marche</span>
            <span className="font-mono text-[#F1F5F9]">
              {feedStatus.source === 'twelvedata'
                ? `Twelve Data ${config.symbol} 3min`
                : config.symbol === 'EUR/USD'
                ? 'EUR/USD 1m→M3 + Spot Swissquote EUR/USD'
                : 'COMEX Gold 1m→M3 + Spot Swissquote XAU/USD'}
            </span>
          </div>
          <div className="py-3 flex items-center justify-between gap-4">
            <span className="text-[#94A3B8]">Etat du flux</span>
            <span className={feedStatus.connected ? 'text-[#10B981] font-medium' : 'text-[#EF4444]'}>
              {feedStatus.connected ? `Connecte · ${feedStatus.barCount} bougies M3 (M5 independant)` : feedStatus.lastError ?? 'Deconnecte'}
            </span>
          </div>
          <div className="py-3 flex items-center justify-between gap-4">
            <span className="text-[#94A3B8]">Token Bot Telegram (.env serveur)</span>
            <span className="font-mono tabular-nums text-[#F1F5F9]">
              {config.hasTelegramToken ? config.telegramTokenMasked : 'Non configure'}
            </span>
          </div>
          <div className="py-3 flex items-center justify-between gap-4">
            <span className="text-[#94A3B8]">Chat ID cible</span>
            <span className="font-mono tabular-nums text-[#F1F5F9]">
              {config.telegramChatId || 'Non defini'}
            </span>
          </div>
        </div>

        <div className="pt-2 border-t border-[#1E293B] flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span className="text-xs text-[#94A3B8]">
              Envoyer un message de test formatte avec le dernier niveau {config.symbol} :
            </span>
            <button
              type="button"
              onClick={handleTest}
              disabled={testing}
              className="px-4 py-2 text-xs font-medium bg-[#1E293B] hover:bg-[#334155] text-[#F8FAFC] rounded-md transition-colors cursor-pointer disabled:opacity-50 whitespace-nowrap"
            >
              {testing ? 'Envoi Telegram...' : 'Tester Bot Telegram'}
            </button>
          </div>
          {testFeedback && (
            <p className={`text-xs font-mono ${testFeedback.ok ? 'text-[#10B981]' : 'text-[#EF4444]'}`}>
              {testFeedback.text}
            </p>
          )}
        </div>

        <div className="pt-3 border-t border-[#1E293B] flex flex-col gap-2">
          <h3 className="text-xs font-semibold text-[#10B981]">
            Anti-Veille 24/7 (Serveur Cloud + Navigateur)
          </h3>
          <p className="text-xs text-[#94A3B8] leading-relaxed">
            L'application maintient un Wake Lock et un heartbeat toutes les 25s tant que l'onglet est ouvert. Pour garder les alertes Telegram actives meme navigateur ferme, ajoutez cet endpoint dans un moniteur gratuit (ex: UptimeRobot ou cron-job.org toutes les 5 min) :
          </p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={healthUrl}
              className="flex-1 bg-[#0B0F17] border border-[#1E293B] rounded-md px-2.5 py-1.5 text-[11px] font-mono text-[#E2E8F0] focus:outline-none"
            />
            <button
              type="button"
              onClick={() => void handleCopyHealth()}
              className="px-3 py-1.5 text-xs font-medium bg-[#1E293B] hover:bg-[#334155] text-[#F1F5F9] rounded-md transition-colors whitespace-nowrap cursor-pointer"
            >
              {copiedHealth ? 'Copie' : 'Copier URL'}
            </button>
          </div>
        </div>

        <div className="pt-3 border-t border-[#1E293B]">
          <h3 className="text-xs font-semibold text-[#CBD5E1]">
            Pont Webhook TradingView (optionnel)
          </h3>
          <p className="mt-1 text-xs text-[#94A3B8] leading-relaxed">
            Ce serveur expose aussi l'endpoint POST <code className="font-mono text-[#F1F5F9]">/api/webhook/tradingview</code> pour relayer directement vos alertes Pine Script vers votre bot Telegram sans exposer le token.
          </p>
        </div>
      </div>
    </div>
  );
};
