"use client";

import { C, DevNote, ScreenProps } from "../ui";
import { BPS, formatCollateral, isPriced, marketStatus, outcomeAt, shortAddress } from "~~/utils/tinyperp";

export function LiquidationsScreen({ tp, actions, now, busy, run, dev }: ScreenProps) {
  const { openPositions, markets, config, guard, account } = tp;

  const board = openPositions
    .map(position => {
      const market = markets[Number(position.marketId)];
      const priced = !!market?.price && !!config && isPriced(marketStatus(market, guard, now));
      const outcome = priced && config ? outcomeAt(position, market.price!, config) : undefined;
      // Health is what is left of the margin: 100% at entry, 0% when it is gone.
      const health = outcome && position.margin > 0n ? Number(outcome.payout) / Number(position.margin) : undefined;
      return { position, market, outcome, health };
    })
    .sort((a, b) => (a.health ?? Infinity) - (b.health ?? Infinity));

  const liquidatable = board.filter(row => row.outcome?.liquidatable).length;
  const threshold = config ? Number(config.liquidationThresholdBps) / 10_000 : 0.1;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
        <span className="tp-tag" style={{ background: C.short, fontWeight: 800 }}>
          {liquidatable} liquidatable
        </span>
        <span className="tp-tag">{board.length} open across all traders</span>
        <span className="tp-tag">Sorted by health, worst first</span>
      </div>
      <DevNote show={dev}>
        Reads the 60 most recent position ids. Index PositionOpened events to go further back.
      </DevNote>

      {board.length === 0 && (
        <div
          className="tp-card tp-card--flat"
          style={{ borderStyle: "dashed", alignItems: "center", padding: "40px 24px" }}
        >
          <div style={{ fontSize: 28, fontWeight: 800, letterSpacing: "-0.03em" }}>No open positions.</div>
        </div>
      )}

      {board.map(({ position, market, outcome, health }) => {
        const id = position.id.toString();
        const canLiquidate = !!outcome?.liquidatable;
        const reward = config ? (position.margin * config.liquidatorRewardBps) / BPS : 0n;
        const mine = !!account && position.owner.toLowerCase() === account.toLowerCase();
        const leverage = position.margin > 0n ? Number(position.size / position.margin) : 0;

        return (
          <div
            key={id}
            className="tp-card"
            style={{
              borderRadius: 18,
              boxShadow: canLiquidate ? `5px 5px 0 ${C.short}` : "none",
              padding: "14px 18px",
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,160px),1fr))",
              gap: "12px 18px",
              alignItems: "center",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
              <span style={{ fontWeight: 800, fontSize: 18 }}>
                #{id} {market?.symbol ?? "—"}
              </span>
              <span className="tp-mono" style={{ fontSize: 12, color: "var(--soft)" }}>
                {mine ? "you" : shortAddress(position.owner)}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span
                className="tp-pill"
                style={{ padding: "2px 9px", background: position.isLong ? C.long : C.short, fontWeight: 800 }}
              >
                {position.isLong ? "LONG" : "SHORT"} {leverage}×
              </span>
              <span className="tp-mono" style={{ fontSize: 13 }}>
                {formatCollateral(position.margin)} margin
              </span>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13 }}>
                <span>Health</span>
                <span className="tp-mono" style={{ fontWeight: 500 }}>
                  {health === undefined ? "—" : `${(health * 100).toFixed(1)}%`}
                </span>
              </div>
              <div className="tp-bar" style={{ height: 12 }}>
                <div
                  style={{
                    height: "100%",
                    width: `${Math.min((health ?? 0) * 100, 100)}%`,
                    background: health === undefined || health <= threshold ? C.short : health < 0.35 ? C.sun : C.long,
                  }}
                />
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              {canLiquidate ? (
                <button
                  type="button"
                  className="tp-btn tp-btn--short"
                  disabled={busy || !account}
                  style={{ width: "100%", padding: "11px 14px", borderRadius: 12, fontSize: 15 }}
                  onClick={() =>
                    run(
                      () => actions.liquidate(position.id),
                      `Liquidated #${id}. You earned ${formatCollateral(reward)} tUSD.`,
                    )
                  }
                >
                  Liquidate · +{formatCollateral(reward)}
                </button>
              ) : (
                <span className="tp-mono" style={{ fontSize: 13, color: "var(--soft)" }}>
                  reward if liquidated {formatCollateral(reward)}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
