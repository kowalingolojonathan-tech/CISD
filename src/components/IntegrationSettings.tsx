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
  const [highProbabilityOnly, setHighProbabilityOnly] = useState<boolean>(
    config.highProbabilityOnly
  );
  const [telegramBotToken, setTelegramBotToken] = useState<string>('');
  const [showToken, setShowToken] = useState<boolean>(false);
  const [telegramChatId, setTelegramChatId] = useState<string>(config.telegramChatId);
  const [customWebhookUrl, setCustomWebhookUrl] = useState<string>(config.customWebhookUrl);
  const [alertsEnabled, setAlertsEnabled] = useState<boolean>(config.alertsEnabled);

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
    setHighProbabilityOnly(config.highProbabilityOnly);
    setTelegramChatId(config.telegramChatId);
    setCustomWebhookUrl(config.customWebhookUrl);
    setAlertsEnabled(config.alertsEnabled);
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
        highProbabilityOnly,
        telegramChatId,
        customWebhookUrl,
        alertsEnabled,
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
            Parametres Killzones ICT et CISD M3
          </h2>
          <p className="mt-1 text-xs text-[#94A3B8]">
            Calibration exacte des deux scripts Pine v6. Les moteurs XAU/USD et EUR/USD surveillent en parallele, le biais D1/H4 s'applique a {config.symbol}.
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

          <label className="flex flex-col gap-1.5 text-xs">
            <span className="text-[#CBD5E1] font-medium">Fenetre Confluence Killzone (bougies M3)</span>
            <input
              type="number"
              min={1}
              max={60}
              value={kzLookbackBars}
              onChange={(e) => setKzLookbackBars(Number.parseInt(e.target.value, 10) || 10)}
              className="bg-[#0B0F17] border border-[#1E293B] rounded-md px-3 py-2 text-sm font-mono tabular-nums text-[#F1F5F9] focus:outline-none focus:border-[#2563EB]"
            />
          </label>
        </div>

        <div className="pt-2 border-t border-[#1E293B] flex flex-col gap-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <span className="text-sm font-medium text-[#F1F5F9]">Killzone active requise</span>
              <p className="text-xs text-[#94A3B8]">
                Signale uniquement lorsque le prix evolue pendant une Killzone active (Asia, London, NY AM, NY PM).
              </p>
            </div>
            <button
              type="button"
              onClick={() => setRequireActiveKillzone((v) => !v)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors shrink-0 cursor-pointer ${
                requireActiveKillzone
                  ? 'bg-[#10B981]/15 border-[#10B981]/50 text-[#10B981]'
                  : 'bg-[#0B0F17] border-[#1E293B] text-[#94A3B8]'
              }`}
            >
              {requireActiveKillzone ? 'Killzone Active' : '24h / Tout horaire'}
            </button>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <span className="text-sm font-medium text-[#F1F5F9]">Detection immediate avant reintegration</span>
              <p className="text-xs text-[#94A3B8]">
                Alerte en temps reel intrabar M3 des qu'il y a cassure + CISD contraire, sans attendre le retour dans le range.
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

          <div className="flex items-center justify-between gap-4">
            <div>
              <span className="text-sm font-medium text-[#F1F5F9]">Telegram Haute Probabilite (D1 + H4) uniquement</span>
              <p className="text-xs text-[#94A3B8]">
                N'envoie sur Telegram que lorsque le CISD M3 va dans la meme direction que Daily ET H4.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setHighProbabilityOnly((v) => !v)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md border transition-colors shrink-0 cursor-pointer ${
                highProbabilityOnly
                  ? 'bg-[#10B981]/15 border-[#10B981]/50 text-[#10B981]'
                  : 'bg-[#0B0F17] border-[#1E293B] text-[#94A3B8]'
              }`}
            >
              {highProbabilityOnly ? 'D1+H4 Requis' : 'Toutes alertes'}
            </button>
          </div>

          <div className="flex items-center justify-between gap-4">
            <div>
              <span className="text-sm font-medium text-[#F1F5F9]">Alertes automatiques Telegram</span>
              <p className="text-xs text-[#94A3B8]">
                Envoie un message des qu'une cassure Killzone est suivie d'un CISD contraire M3.
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
            <span className="font-mono font-medium text-[#F1F5F9]">{config.symbol} · M3 (3 min)</span>
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
              {feedStatus.connected ? `Connecte · ${feedStatus.barCount} bougies M3` : feedStatus.lastError ?? 'Deconnecte'}
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
