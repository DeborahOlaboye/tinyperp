"use client";

import { C, ScreenProps } from "../ui";
import { STATUS_COLOR } from "./TradeScreen";
import { deviationBps, formatAge, formatPrice, marketStatus, shortAddress } from "~~/utils/tinyperp";

export function MarketsScreen({ tp, now }: ScreenProps) {
  const { markets, guard } = tp;
  const maxDeviation = Number(guard?.maxDeviationBps ?? 0n);

  return (
    <div className="tp-grid" style={{ gridTemplateColumns: "repeat(auto-fill,minmax(min(100%,340px),1fr))" }}>
      {markets.map(market => {
        const status = marketStatus(market, guard, now);
        const deviation = deviationBps(market, guard, now);
        const age = market.updatedAt ? Math.max(now - Number(market.updatedAt), 0) : undefined;
        const maxAge = Number(market.maxPriceAge);
        const supraStale = market.crossCheck && market.supraPrice !== undefined && deviation === undefined;

        return (
          <div key={market.symbol} className="tp-card" style={{ padding: "20px 22px", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.03em" }}>{market.symbol}</span>
              <span className="tp-mono tp-pill" style={{ marginLeft: "auto", background: STATUS_COLOR[status] }}>
                {status}
              </span>
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div style={{ padding: 12, borderRadius: 14, border: `2px solid ${C.ink}`, background: C.sun }}>
                <div style={{ fontSize: 13, fontWeight: 700 }}>Chainlink · price</div>
                <div className="tp-mono" style={{ fontSize: 18, fontWeight: 500, overflowWrap: "anywhere" }}>
                  {formatPrice(market.price)}
                </div>
              </div>
              <div
                style={{
                  padding: 12,
                  borderRadius: 14,
                  border: `2px solid ${C.ink}`,
                  background: !market.crossCheck ? C.bg : status === "Halted" ? C.short : C.lilac,
                }}
              >
                <div style={{ fontSize: 13, fontWeight: 700 }}>Supra · check</div>
                <div className="tp-mono" style={{ fontSize: 18, fontWeight: 500, overflowWrap: "anywhere" }}>
                  {market.crossCheck ? formatPrice(market.supraPrice) : "not checked"}
                </div>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
                <span style={{ fontWeight: 700 }}>Disagreement</span>
                <span className="tp-mono">
                  {!market.crossCheck
                    ? "—"
                    : supraStale
                      ? "Supra stale, ignored"
                      : `${deviation === undefined ? "—" : Math.round(deviation)} / ${maxDeviation} bps`}
                </span>
              </div>
              <div className="tp-bar" style={{ height: 14 }}>
                <div
                  style={{
                    height: "100%",
                    width: `${deviation === undefined || !maxDeviation ? 0 : Math.min((deviation / maxDeviation) * 100, 100)}%`,
                    background:
                      (deviation ?? 0) > maxDeviation
                        ? C.short
                        : (deviation ?? 0) > maxDeviation * 0.6
                          ? C.sun
                          : C.long,
                  }}
                />
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 14 }}>
                <span style={{ fontWeight: 700 }}>Price age</span>
                <span className="tp-mono">
                  {age === undefined ? "—" : formatAge(age)} / {formatAge(maxAge)}
                </span>
              </div>
              <div className="tp-bar" style={{ height: 14 }}>
                <div
                  style={{
                    height: "100%",
                    width: `${age === undefined ? 0 : Math.min((age / maxAge) * 100, 100)}%`,
                    background: status === "Stale" ? C.short : C.lilac,
                  }}
                />
              </div>
            </div>

            <div
              className="tp-mono"
              style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "var(--soft)" }}
            >
              <span style={{ overflowWrap: "anywhere" }}>
                feed{" "}
                <a
                  href={`${tp.network.blockExplorers?.default.url}/contract/${market.feed}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {shortAddress(market.feed)}
                </a>
              </span>
              <span>
                max {market.maxLeverage.toString()}× ·{" "}
                {market.crossCheck ? `Supra pair ${market.supraPairIndex}` : "no cross-check"}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
