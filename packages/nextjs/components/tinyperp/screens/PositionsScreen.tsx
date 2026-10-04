"use client";

import { C, ScreenProps, priceBar } from "../ui";
import { zeroAddress } from "viem";
import {
  collateralToNumber,
  formatCollateral,
  formatCountdown,
  formatNumber,
  formatPrice,
  formatSigned,
  isPriced,
  marketStatus,
  outcomeAt,
  priceToNumber,
} from "~~/utils/tinyperp";

export function PositionsScreen({ tp, actions, now, busy, run, go }: ScreenProps) {
  const { positions, markets, config, guard } = tp;

  const rows = positions.map(position => {
    const market = markets[Number(position.marketId)];
    const priced = !!market && !!config && isPriced(marketStatus(market, guard, now));
    const outcome = priced && market?.price && config ? outcomeAt(position, market.price, config) : undefined;
    return { position, market, outcome };
  });

  const totalMargin = positions.reduce((sum, position) => sum + position.margin, 0n);
  const totalPnl = rows.reduce((sum, row) => sum + (row.outcome?.pnl ?? 0n), 0n);
  const totalPayout = rows.reduce((sum, row) => sum + (row.outcome?.payout ?? 0n), 0n);
  const thresholdPercent = config ? Number(config.liquidationThresholdBps) / 100 : 10;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,220px),1fr))", gap: 14 }}>
        <div className="tp-tile">
          <div style={{ fontSize: 14, color: "var(--soft)" }}>Margin at work</div>
          <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: "-0.04em" }}>{formatCollateral(totalMargin)}</div>
        </div>
        <div className="tp-tile" style={{ background: totalPnl >= 0n ? C.long : C.short }}>
          <div style={{ fontSize: 14 }}>Unrealised PnL</div>
          <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: "-0.04em" }}>
            {formatSigned(collateralToNumber(totalPnl))}
          </div>
        </div>
        <div className="tp-tile">
          <div style={{ fontSize: 14, color: "var(--soft)" }}>Payout if closed now</div>
          <div style={{ fontSize: 32, fontWeight: 800, letterSpacing: "-0.04em" }}>{formatCollateral(totalPayout)}</div>
        </div>
      </div>

      {rows.length === 0 && (
        <div
          style={{
            padding: "40px 24px",
            borderRadius: 22,
            border: `2.5px dashed ${C.ink}`,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 14,
            textAlign: "center",
          }}
        >
          <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-0.03em" }}>
            {tp.account ? "Nothing open." : "Connect a wallet to see your positions."}
          </div>
          <button
            type="button"
            className="tp-btn tp-btn--sun"
            style={{ padding: "12px 22px", borderRadius: 999, fontSize: 16 }}
            onClick={() => go("trade")}
          >
            Open a position
          </button>
        </div>
      )}

      <div className="tp-grid" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,330px),1fr))" }}>
        {rows.map(({ position, market, outcome }) => {
          const leverage = position.margin > 0n ? Number(position.size / position.margin) : 0;
          const entry = priceToNumber(position.entryPrice);
          const bar = config
            ? priceBar(
                entry,
                position.isLong,
                leverage,
                config,
                market?.price ? priceToNumber(market.price) : undefined,
              )
            : undefined;
          const expired = now >= Number(position.expiresAt);
          const booked = position.schedule !== zeroAddress;
          const pnl = outcome ? collateralToNumber(outcome.pnl) : undefined;
          const margin = collateralToNumber(position.margin);
          const symbol = market?.symbol ?? `Market ${position.marketId}`;
          const id = position.id.toString();

          const stats = [
            ["Size", formatCollateral(position.size)],
            ["Payout now", outcome ? formatCollateral(outcome.payout) : "—"],
            ["Entry", formatPrice(position.entryPrice)],
            ["Mark", formatPrice(market?.price)],
            ["Margin", formatCollateral(position.margin)],
            ["Expires in", formatCountdown(Number(position.expiresAt) - now)],
          ];

          return (
            <div key={id} className="tp-card" style={{ padding: 20, gap: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <span
                  className="tp-pill"
                  style={{ background: position.isLong ? C.long : C.short, fontWeight: 800, fontSize: 13 }}
                >
                  {position.isLong ? "LONG" : "SHORT"} {leverage}×
                </span>
                <span style={{ fontWeight: 800, fontSize: 20 }}>{symbol}</span>
                <span className="tp-mono" style={{ marginLeft: "auto", fontSize: 13, color: "var(--muted)" }}>
                  #{id}
                </span>
              </div>

              <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
                <span
                  style={{
                    fontSize: 44,
                    fontWeight: 800,
                    letterSpacing: "-0.05em",
                    lineHeight: 1,
                    fontVariantNumeric: "tabular-nums",
                  }}
                >
                  {pnl === undefined ? "—" : formatSigned(pnl)}
                </span>
                {pnl !== undefined && (
                  <span
                    className="tp-mono tp-pill"
                    style={{ background: pnl >= 0 ? C.long : C.short, fontSize: 13, padding: "2px 9px" }}
                  >
                    {pnl >= 0 ? "+" : "−"}
                    {formatNumber(Math.abs((pnl / margin) * 100), 1)}%
                  </span>
                )}
              </div>

              {bar && (
                <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                  <div style={{ position: "relative", height: 16, margin: "0 9px" }}>
                    <div
                      style={{
                        position: "absolute",
                        inset: 0,
                        borderRadius: 999,
                        border: `2px solid ${C.ink}`,
                        background: bar.gradient,
                      }}
                    />
                    <div
                      style={{
                        position: "absolute",
                        left: bar.entryLeft,
                        top: -4,
                        bottom: -4,
                        width: 3,
                        background: C.ink,
                        transform: "translateX(-50%)",
                      }}
                    />
                    <div
                      style={{
                        position: "absolute",
                        left: bar.nowLeft,
                        top: "50%",
                        width: 20,
                        height: 20,
                        borderRadius: "50%",
                        background: C.paper,
                        border: `3px solid ${C.ink}`,
                        transform: "translate(-50%,-50%)",
                      }}
                    />
                  </div>
                  <div
                    className="tp-mono"
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 8,
                      fontSize: 12,
                      color: "var(--soft)",
                    }}
                  >
                    <span>{position.isLong ? `liq ${bar.liquidation}` : `cap ${bar.cap}`}</span>
                    <span>{position.isLong ? `cap ${bar.cap}` : `liq ${bar.liquidation}`}</span>
                  </div>
                </div>
              )}

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 16px" }}>
                {stats.map(([label, value]) => (
                  <div key={label} style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0 }}>
                    <span style={{ fontSize: 13, color: "var(--muted)" }}>{label}</span>
                    <span className="tp-mono" style={{ fontSize: 15, fontWeight: 500, overflowWrap: "anywhere" }}>
                      {value}
                    </span>
                  </div>
                ))}
              </div>

              {outcome?.liquidatable && (
                <div className="tp-level" style={{ background: C.short, fontWeight: 700, fontSize: 14 }}>
                  Health under {thresholdPercent}%. Anyone can liquidate this now.
                </div>
              )}
              {!outcome && (
                <div className="tp-level" style={{ background: C.dim, fontWeight: 700, fontSize: 14 }}>
                  {symbol} has no tradable price right now, so this cannot settle yet.
                </div>
              )}

              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                {expired ? (
                  <button
                    type="button"
                    className="tp-btn tp-btn--sun"
                    disabled={busy || !outcome}
                    style={{ flex: 1, padding: 13, fontSize: 16 }}
                    onClick={() =>
                      run(
                        () => actions.settleExpired(position.id),
                        `Settled #${id}. Paid ${formatCollateral(outcome?.payout ?? 0n)} tUSD.`,
                      )
                    }
                  >
                    Settle expired
                  </button>
                ) : (
                  <button
                    type="button"
                    className="tp-btn"
                    disabled={busy || !outcome}
                    style={{ flex: 1, padding: 13, fontSize: 16 }}
                    onClick={() =>
                      run(
                        () => actions.closePosition(position.id),
                        `Closed #${id}. Paid ${formatCollateral(outcome?.payout ?? 0n)} tUSD.`,
                      )
                    }
                  >
                    Close · get {outcome ? formatCollateral(outcome.payout) : "—"}
                  </button>
                )}
                <span className="tp-mono tp-pill" style={{ padding: "4px 10px", background: booked ? C.sun : C.bg }}>
                  {booked ? "auto-settle booked" : "manual settle"}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
