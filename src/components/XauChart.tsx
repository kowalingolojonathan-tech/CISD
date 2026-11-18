import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  formatSymbolPrice,
  type Candle,
  type CisdSignal,
  type ConfluenceAlert,
  type SessionBox,
  type SupportedSymbol,
  type SwingPivot,
  type TimezoneMode,
  type UnsweptLevel,
} from '../engine/types';

interface XauChartProps {
  symbol: SupportedSymbol;
  candles: Candle[];
  candleTrends: number[];
  sessions: SessionBox[];
  unsweptLevels: UnsweptLevel[];
  swingPivots: SwingPivot[];
  cisdSignals: CisdSignal[];
  confluenceAlerts: ConfluenceAlert[];
  tzMode: TimezoneMode;
  onRefresh: () => void;
  refreshing: boolean;
  onOpenSettings?: () => void;
}

function formatNyShort(ts: number, tzMode: TimezoneMode): string {
  const d = new Date(ts);
  let offset = -5;
  if (tzMode === 'Manual UTC-4 (EDT)') offset = -4;
  else if (tzMode === 'Auto (DST)') {
    const mo = d.getUTCMonth() + 1;
    const dy = d.getUTCDate();
    const dw = d.getUTCDay();
    if (
      (mo > 3 && mo < 11) ||
      (mo === 3 && ((dy >= 8 && dy <= 14 && dw === 0) || dy > 14)) ||
      (mo === 11 && ((dy < 7 && dw !== 0) || (dy === 7 && dw !== 0)))
    ) {
      offset = -4;
    }
  }
  const shifted = new Date(ts + offset * 3600 * 1000);
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  const mo = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const da = String(shifted.getUTCDate()).padStart(2, '0');
  return `${da}/${mo} ${hh}:${mm}`;
}

export const XauChart: React.FC<XauChartProps> = ({
  symbol,
  candles,
  candleTrends,
  sessions,
  unsweptLevels,
  swingPivots,
  cisdSignals,
  confluenceAlerts,
  tzMode,
  onRefresh,
  refreshing,
  onOpenSettings,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const [visibleCount, setVisibleCount] = useState<number>(140);
  const [panOffset, setPanOffset] = useState<number>(0); // bars shifted back from end
  const [showBoxes, setShowBoxes] = useState<boolean>(true);
  const [showUnswept, setShowUnswept] = useState<boolean>(true);
  const [showSwings, setShowSwings] = useState<boolean>(true);
  const [showCisd, setShowCisd] = useState<boolean>(true);

  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);
  const dragStateRef = useRef<{ dragging: boolean; startX: number; startOffset: number }>({
    dragging: false,
    startX: 0,
    startOffset: 0,
  });

  const viewSlice = useMemo(() => {
    const total = candles.length;
    if (total === 0) return { start: 0, end: 0 };
    const count = Math.min(visibleCount, total);
    const maxOffset = Math.max(0, total - count);
    const clampedOffset = Math.max(0, Math.min(panOffset, maxOffset));
    const end = total - clampedOffset;
    const start = Math.max(0, end - count);
    return { start, end };
  }, [candles.length, visibleCount, panOffset]);

  const confluenceByBar = useMemo(() => {
    const map = new Map<number, ConfluenceAlert>();
    for (const a of confluenceAlerts) {
      map.set(a.cisd.barIndex, a);
    }
    return map;
  }, [confluenceAlerts]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const draw = () => {
      const rect = container.getBoundingClientRect();
      const width = Math.max(320, Math.floor(rect.width));
      const height = Math.max(380, Math.floor(rect.height));
      const dpr = window.devicePixelRatio || 1;

      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Clear background
      ctx.fillStyle = '#0B0F17';
      ctx.fillRect(0, 0, width, height);

      const padLeft = 14;
      const padRight = 78;
      const padTop = 22;
      const padBottom = 28;
      const plotW = width - padLeft - padRight;
      const plotH = height - padTop - padBottom;

      const { start, end } = viewSlice;
      const count = end - start;
      if (count <= 0) {
        ctx.fillStyle = '#64748B';
        ctx.font = '13px "Plus Jakarta Sans", sans-serif';
        ctx.fillText(`Chargement des donnees reelles ${symbol} M3...`, padLeft + 16, padTop + 40);
        return;
      }

      // Compute price range from visible candles & visible unswept levels
      let minP = Number.POSITIVE_INFINITY;
      let maxP = Number.NEGATIVE_INFINITY;
      for (let i = start; i < end; i++) {
        const c = candles[i];
        if (c.low < minP) minP = c.low;
        if (c.high > maxP) maxP = c.high;
      }
      if (showUnswept) {
        for (const lvl of unsweptLevels) {
          if (!lvl.swept && lvl.level >= minP * 0.99 && lvl.level <= maxP * 1.01) {
            minP = Math.min(minP, lvl.level);
            maxP = Math.max(maxP, lvl.level);
          }
        }
      }
      if (!Number.isFinite(minP) || !Number.isFinite(maxP) || maxP <= minP) {
        const fallbackPad = symbol === 'EUR/USD' ? 0.002 : 2;
        minP -= fallbackPad;
        maxP += fallbackPad;
      }
      const priceSpan = maxP - minP;
      minP -= priceSpan * 0.08;
      maxP += priceSpan * 0.08;

      const rightReserveBars = 8; // Anticipation space on right
      const slotCount = count + rightReserveBars;
      const stepX = plotW / slotCount;
      const candleW = Math.max(2, Math.min(11, stepX * 0.68));

      const xForIndex = (idx: number) => padLeft + (idx - start + 0.5) * stepX;
      const yForPrice = (p: number) => padTop + ((maxP - p) / (maxP - minP)) * plotH;

      // Grid lines
      ctx.strokeStyle = 'rgba(30, 41, 59, 0.55)';
      ctx.lineWidth = 1;
      const gridRows = 6;
      ctx.font = '11px "JetBrains Mono", monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';

      for (let r = 0; r <= gridRows; r++) {
        const p = minP + ((maxP - minP) * r) / gridRows;
        const y = Math.round(yForPrice(p)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(padLeft, y);
        ctx.lineTo(padLeft + plotW, y);
        ctx.stroke();

        ctx.fillStyle = '#64748B';
        ctx.fillText(formatSymbolPrice(p, symbol), padLeft + plotW + 8, y);
      }

      // Vertical time grid
      const timeStep = Math.max(10, Math.floor(count / 6));
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let i = start; i < end; i += timeStep) {
        const x = Math.round(xForIndex(i)) + 0.5;
        ctx.beginPath();
        ctx.strokeStyle = 'rgba(30, 41, 59, 0.4)';
        ctx.moveTo(x, padTop);
        ctx.lineTo(x, padTop + plotH);
        ctx.stroke();

        ctx.fillStyle = '#64748B';
        ctx.fillText(formatNyShort(candles[i].time, tzMode), x, padTop + plotH + 8);
      }

      // Clip plotting area
      ctx.save();
      ctx.beginPath();
      ctx.rect(padLeft, padTop, plotW, plotH);
      ctx.clip();

      // 1. Session Killzones Boxes
      if (showBoxes) {
        for (const box of sessions) {
          if (box.endIndex < start || box.startIndex >= end) continue;
          const x1 = Math.max(padLeft, xForIndex(Math.max(box.startIndex, start)) - stepX * 0.5);
          const x2 = Math.min(padLeft + plotW, xForIndex(Math.min(box.endIndex, end - 1)) + stepX * 0.5);
          const yTop = yForPrice(box.hi);
          const yBot = yForPrice(box.lo);
          const boxH = Math.max(2, yBot - yTop);

          ctx.fillStyle = `${box.color}16`;
          ctx.fillRect(x1, yTop, Math.max(2, x2 - x1), boxH);

          ctx.strokeStyle = `${box.color}88`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x1, yTop);
          ctx.lineTo(x2, yTop);
          ctx.moveTo(x1, yBot);
          ctx.lineTo(x2, yBot);
          ctx.stroke();

          ctx.fillStyle = '#CBD5E1';
          ctx.font = '600 10px "Plus Jakarta Sans", sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'bottom';
          ctx.fillText(box.name, (x1 + x2) / 2, Math.max(padTop + 12, yTop - 3));
        }
      }

      // 2. Unswept Levels (active extended to right, swept terminated at sweep bar)
      if (showUnswept) {
        for (const lvl of unsweptLevels) {
          if (lvl.swept && lvl.sweptBarIndex !== null && lvl.sweptBarIndex < start) continue;
          if (!lvl.swept && lvl.createdBarIndex >= end) continue;

          const startIdx = Math.max(start, lvl.createdBarIndex);
          const x1 = xForIndex(startIdx);
          const x2 = lvl.swept && lvl.sweptBarIndex !== null
            ? xForIndex(Math.min(end - 1, lvl.sweptBarIndex))
            : padLeft + plotW;

          if (x2 <= x1) continue;
          const y = yForPrice(lvl.level);

          ctx.save();
          ctx.strokeStyle = lvl.swept ? `${lvl.color}55` : `${lvl.color}CC`;
          ctx.lineWidth = lvl.swept ? 1 : 1.25;
          ctx.setLineDash([4, 4]);
          ctx.beginPath();
          ctx.moveTo(x1, y);
          ctx.lineTo(x2, y);
          ctx.stroke();
          ctx.restore();

          if (!lvl.swept) {
            ctx.fillStyle = lvl.color;
            ctx.font = '600 10px "JetBrains Mono", monospace';
            ctx.textAlign = 'right';
            ctx.textBaseline = 'bottom';
            ctx.fillText(
              `${lvl.shortName}.${lvl.isHigh ? 'H' : 'L'} ${formatSymbolPrice(lvl.level, symbol)}`,
              padLeft + plotW - 6,
              y - 2
            );
          }
        }
      }

      // 3. AlgoAlpha Swing Pivots
      if (showSwings) {
        for (const piv of swingPivots) {
          if (piv.barIndex < start || piv.barIndex >= end) continue;
          const px = xForIndex(piv.barIndex);
          const py = yForPrice(piv.level);

          // Swing liquidity horizontal line up to mitigation/expiry
          const endBar = piv.mitigatedBarIndex ?? Math.min(end - 1, piv.barIndex + 100);
          const lx2 = xForIndex(Math.min(end - 1, endBar));
          if (lx2 > px) {
            ctx.save();
            ctx.strokeStyle = 'rgba(148, 163, 184, 0.28)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(px, py);
            ctx.lineTo(lx2, py);
            ctx.stroke();
            ctx.restore();
          }

          ctx.fillStyle = piv.type === 'high' ? '#FF1100' : '#00FFBB';
          ctx.beginPath();
          ctx.arc(px, py, 2.5, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      // 4. Candlesticks colored by CISD trend
      for (let i = start; i < end; i++) {
        const c = candles[i];
        const tr = candleTrends[i] ?? 0;
        const x = xForIndex(i);
        const yHigh = yForPrice(c.high);
        const yLow = yForPrice(c.low);
        const yOpen = yForPrice(c.open);
        const yClose = yForPrice(c.close);

        const isUpCandle = c.close >= c.open;
        let bodyColor = isUpCandle ? '#64748B' : '#475569';
        let wickColor = '#64748B';

        if (tr > 0) {
          bodyColor = isUpCandle ? 'rgba(0, 255, 187, 0.35)' : 'rgba(0, 255, 187, 0.14)';
          wickColor = '#00FFBB';
        } else if (tr < 0) {
          bodyColor = isUpCandle ? 'rgba(255, 17, 0, 0.14)' : 'rgba(255, 17, 0, 0.38)';
          wickColor = '#FF3B30';
        }

        // Wick
        ctx.strokeStyle = wickColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x, yHigh);
        ctx.lineTo(x, yLow);
        ctx.stroke();

        // Body
        const bodyTop = Math.min(yOpen, yClose);
        const bodyH = Math.max(1.5, Math.abs(yClose - yOpen));
        ctx.fillStyle = bodyColor;
        ctx.fillRect(x - candleW / 2, bodyTop, candleW, bodyH);
        ctx.strokeStyle = wickColor;
        ctx.strokeRect(x - candleW / 2, bodyTop, candleW, bodyH);
      }

      // 5. CISD Origin Lines & Confluence Markers
      if (showCisd) {
        for (const sig of cisdSignals) {
          if (sig.barIndex < start && sig.originBarIndex < start) continue;
          if (sig.originBarIndex >= end) continue;

          const x1 = xForIndex(Math.max(start, sig.originBarIndex));
          const x2 = xForIndex(Math.min(end - 1, sig.barIndex));
          const y = yForPrice(sig.originLevel);
          const col = sig.direction === 'bullish' ? '#00FFBB' : '#FF3B30';

          ctx.strokeStyle = col;
          ctx.lineWidth = 2.5;
          ctx.beginPath();
          ctx.moveTo(x1, y);
          ctx.lineTo(Math.max(x1 + 6, x2), y);
          ctx.stroke();

          if (sig.barIndex >= start && sig.barIndex < end) {
            const sx = xForIndex(sig.barIndex);
            const conf = confluenceByBar.get(sig.barIndex);
            if (conf) {
              // Highlight Confluence Signal (Killzone Sweep + M3 CISD)
              const cy =
                sig.direction === 'bearish'
                  ? yForPrice(candles[sig.barIndex].high) - 14
                  : yForPrice(candles[sig.barIndex].low) + 14;
              ctx.fillStyle = sig.direction === 'bearish' ? '#FF3B30' : '#00FFBB';
              ctx.font = '700 13px "Plus Jakarta Sans", sans-serif';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(sig.direction === 'bearish' ? '▼' : '▲', sx, cy);

              ctx.font = '600 9px "JetBrains Mono", monospace';
              ctx.fillStyle = '#F8FAFC';
              ctx.fillText(
                `KZ+${conf.kzSweep.shortName}`,
                sx,
                sig.direction === 'bearish' ? cy - 12 : cy + 12
              );
            } else if (sig.strongSweep) {
              const cy =
                sig.direction === 'bearish'
                  ? yForPrice(candles[sig.barIndex].high) - 10
                  : yForPrice(candles[sig.barIndex].low) + 10;
              ctx.fillStyle = col;
              ctx.font = '10px "Plus Jakarta Sans", sans-serif';
              ctx.textAlign = 'center';
              ctx.textBaseline = 'middle';
              ctx.fillText(sig.direction === 'bearish' ? '▼' : '▲', sx, cy);
            }
          }
        }
      }

      // 6. Current price dashed line
      const latest = candles[candles.length - 1];
      if (latest) {
        const py = yForPrice(latest.close);
        ctx.save();
        ctx.strokeStyle = 'rgba(59, 130, 246, 0.7)';
        ctx.setLineDash([2, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(padLeft, py);
        ctx.lineTo(padLeft + plotW, py);
        ctx.stroke();
        ctx.restore();
      }

      // 7. Crosshair
      if (hoverIdx !== null && hoverIdx >= start && hoverIdx < end && hoverPos) {
        const hx = xForIndex(hoverIdx);
        ctx.save();
        ctx.strokeStyle = 'rgba(148, 163, 184, 0.45)';
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(hx, padTop);
        ctx.lineTo(hx, padTop + plotH);
        ctx.moveTo(padLeft, hoverPos.y);
        ctx.lineTo(padLeft + plotW, hoverPos.y);
        ctx.stroke();
        ctx.restore();
      }

      ctx.restore();

      // Current price Y-axis badge
      if (latest) {
        const py = Math.max(padTop + 10, Math.min(padTop + plotH - 10, yForPrice(latest.close)));
        ctx.fillStyle = '#2563EB';
        ctx.fillRect(padLeft + plotW + 2, py - 9, padRight - 4, 18);
        ctx.fillStyle = '#FFFFFF';
        ctx.font = '600 11px "JetBrains Mono", monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(formatSymbolPrice(latest.close, symbol), padLeft + plotW + 7, py);
      }
    };

    draw();
    const ro = new ResizeObserver(draw);
    ro.observe(container);
    return () => ro.disconnect();
  }, [
    symbol,
    candles,
    candleTrends,
    sessions,
    unsweptLevels,
    swingPivots,
    cisdSignals,
    confluenceByBar,
    viewSlice,
    showBoxes,
    showUnswept,
    showSwings,
    showCisd,
    hoverIdx,
    hoverPos,
    tzMode,
  ]);

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (dragStateRef.current.dragging) {
      const dx = x - dragStateRef.current.startX;
      const plotW = rect.width - 14 - 78;
      const count = viewSlice.end - viewSlice.start;
      const stepX = plotW / (count + 8);
      const barShift = Math.round(dx / Math.max(2, stepX));
      const maxOffset = Math.max(0, candles.length - Math.min(visibleCount, candles.length));
      setPanOffset(Math.max(0, Math.min(maxOffset, dragStateRef.current.startOffset + barShift)));
      return;
    }

    const plotW = rect.width - 14 - 78;
    const count = viewSlice.end - viewSlice.start;
    if (count <= 0) return;
    const stepX = plotW / (count + 8);
    const rel = Math.floor((x - 14) / stepX);
    const idx = viewSlice.start + rel;
    if (idx >= viewSlice.start && idx < viewSlice.end) {
      setHoverIdx(idx);
      setHoverPos({ x, y });
    } else {
      setHoverIdx(null);
      setHoverPos(null);
    }
  };

  const handleWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 18 : -18;
    setVisibleCount((prev) => Math.max(40, Math.min(400, prev + delta)));
  };

  const hoveredCandle = hoverIdx !== null ? candles[hoverIdx] : candles[candles.length - 1];
  const hoveredTrend = hoverIdx !== null ? candleTrends[hoverIdx] : candleTrends[candleTrends.length - 1];

  return (
    <div className="flex flex-col bg-[#111827] border border-[#1E293B] rounded-lg overflow-hidden">
      {/* Chart Control Strip */}
      <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-2.5 border-b border-[#1E293B] bg-[#0F1521]">
        <div className="flex items-center gap-3 min-w-0">
          <span className="text-sm font-semibold text-[#F1F5F9] whitespace-nowrap">
            {symbol} · M3
          </span>
          {hoveredCandle && (
            <div className="hidden lg:flex items-center gap-3 text-xs font-mono tabular-nums text-[#94A3B8]">
              <span>O {formatSymbolPrice(hoveredCandle.open, symbol)}</span>
              <span>H {formatSymbolPrice(hoveredCandle.high, symbol)}</span>
              <span>L {formatSymbolPrice(hoveredCandle.low, symbol)}</span>
              <span className="text-[#F1F5F9] font-medium">
                C {formatSymbolPrice(hoveredCandle.close, symbol)}
              </span>
              <span aria-hidden="true">·</span>
              <span>{formatNyShort(hoveredCandle.time, tzMode)} NY</span>
              <span aria-hidden="true">·</span>
              <span
                className={
                  hoveredTrend > 0
                    ? 'text-[#10B981]'
                    : hoveredTrend < 0
                    ? 'text-[#EF4444]'
                    : 'text-[#64748B]'
                }
              >
                {hoveredTrend > 0 ? 'Biais HAUSSIER' : hoveredTrend < 0 ? 'Biais BAISSIER' : 'Biais NEUTRE'}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <div className="flex items-center bg-[#0B0F17] border border-[#1E293B] rounded-md p-0.5">
            {[
              { label: 'Boxes', active: showBoxes, toggle: () => setShowBoxes((v) => !v) },
              { label: 'Unswept', active: showUnswept, toggle: () => setShowUnswept((v) => !v) },
              { label: 'Swings', active: showSwings, toggle: () => setShowSwings((v) => !v) },
              { label: 'CISD', active: showCisd, toggle: () => setShowCisd((v) => !v) },
            ].map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={item.toggle}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  item.active
                    ? 'bg-[#1E293B] text-[#F8FAFC]'
                    : 'text-[#64748B] hover:text-[#CBD5E1]'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>

          <div className="hidden sm:flex items-center bg-[#0B0F17] border border-[#1E293B] rounded-md p-0.5">
            {[80, 140, 260].map((cnt) => (
              <button
                key={cnt}
                type="button"
                onClick={() => {
                  setVisibleCount(cnt);
                  setPanOffset(0);
                }}
                className={`px-2 py-1 text-xs font-mono tabular-nums rounded transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                  visibleCount === cnt && panOffset === 0
                    ? 'bg-[#1E293B] text-[#F8FAFC]'
                    : 'text-[#64748B] hover:text-[#CBD5E1]'
                }`}
              >
                {cnt}b
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="px-3 py-1.5 text-xs font-medium bg-[#1E293B] hover:bg-[#334155] text-[#F1F5F9] rounded-md transition-colors whitespace-nowrap shrink-0 disabled:opacity-50 cursor-pointer"
          >
            {refreshing ? 'Synchronisation...' : 'Actualiser'}
          </button>

          {onOpenSettings && (
            <button
              type="button"
              onClick={onOpenSettings}
              className="px-3 py-1.5 text-xs font-medium bg-[#0B0F17] border border-[#1E293B] hover:border-[#334155] text-[#CBD5E1] rounded-md transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              Parametres
            </button>
          )}
        </div>
      </div>

      {/* Canvas Viewport */}
      <div ref={containerRef} className="relative w-full h-[460px] select-none">
        <canvas
          ref={canvasRef}
          onMouseDown={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            dragStateRef.current = {
              dragging: true,
              startX: e.clientX - rect.left,
              startOffset: panOffset,
            };
          }}
          onMouseUp={() => {
            dragStateRef.current.dragging = false;
          }}
          onMouseLeave={() => {
            dragStateRef.current.dragging = false;
            setHoverIdx(null);
            setHoverPos(null);
          }}
          onMouseMove={handleMouseMove}
          onWheel={handleWheel}
          className="block w-full h-full cursor-crosshair"
        />
      </div>
    </div>
  );
};
