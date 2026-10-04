"use client";

import { useState } from "react";
import { ActionButton, C, DevNote, ScreenProps, Toggle } from "../ui";
import { isAddress } from "viem";
import {
  formatCollateral,
  formatDuration,
  formatNumber,
  fromRpcValue,
  shortAddress,
  toRpcValue,
} from "~~/utils/tinyperp";

const emptyForm = { symbol: "", feed: "", maxLeverage: "10", maxAge: "90000", crossCheck: false, pair: "" };

const percent = (bps: bigint) => `${bps} · ${(Number(bps) / 100).toFixed(2)}%`;

export function AdminScreen({ tp, actions, busy, run, dev }: ScreenProps) {
  const { markets, config, owner, isOwner, budget } = tp;
  const [form, setForm] = useState(emptyForm);
  const patch = (change: Partial<typeof emptyForm>) => setForm(current => ({ ...current, ...change }));

  const notOwner = !tp.account
    ? "Connect the owner wallet"
    : tp.wrongNetwork
      ? `Switch your wallet to ${tp.network.name}`
      : !isOwner
        ? "Only the engine owner can do this"
        : null;

  const symbol = form.symbol.trim();
  const feed = form.feed.trim();
  const formReason =
    notOwner ??
    (symbol.length < 3 || !isAddress(feed)
      ? "Add a symbol and feed address"
      : !(parseInt(form.maxLeverage, 10) > 0) || !(parseInt(form.maxAge, 10) > 0)
        ? "Leverage and price age must be above zero"
        : form.crossCheck && form.pair === ""
          ? "Add the Supra pair index"
          : null);

  const budgetHbar = budget === undefined ? undefined : Number(budget) / 1e18;

  const parameters: [string, string][] = config
    ? [
        ["openFeeBps", percent(config.openFeeBps)],
        ["spreadBps", percent(config.spreadBps)],
        ["liquidationThresholdBps", percent(config.liquidationThresholdBps)],
        ["liquidatorRewardBps", percent(config.liquidatorRewardBps)],
        ["maxProfitMultiple", `${config.maxProfitMultiple}×`],
        ["minDuration", formatDuration(Number(config.minDuration))],
        ["maxDuration", formatDuration(Number(config.maxDuration))],
        ["minCollateral", `${formatCollateral(config.minCollateral, 0)} tUSD`],
        ["autoSettleFee", `${formatNumber(Number(toRpcValue(config.autoSettleFee, tp.chainId)) / 1e18, 2)} HBAR`],
        ["autoSettleGasLimit", Number(config.autoSettleGasLimit).toLocaleString("en-US")],
        ["scheduleCallGas", Number(config.scheduleCallGas).toLocaleString("en-US")],
      ]
    : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <div
        style={{
          padding: "12px 16px",
          borderRadius: 14,
          border: `2.5px solid ${C.ink}`,
          background: isOwner ? C.sun : C.paper,
          fontWeight: 700,
          fontSize: 15,
        }}
      >
        {isOwner
          ? "Connected wallet is the engine owner. The owner can’t touch collateral, change parameters or move positions."
          : `These controls belong to the engine owner${owner ? ` (${shortAddress(owner)})` : ""}. The owner can’t touch collateral, change parameters or move positions.`}
      </div>

      <div className="tp-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,360px),1fr))" }}>
        <div className="tp-card" style={{ gap: 4 }}>
          <span style={{ fontSize: 22, fontWeight: 800, marginBottom: 8 }}>Markets</span>
          {markets.map(market => (
            <div
              key={market.symbol}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                padding: "12px 0",
                borderTop: "1.5px dashed var(--rule)",
              }}
            >
              <div style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 800, fontSize: 17 }}>{market.symbol}</span>
                <span style={{ fontSize: 13, color: "var(--soft)" }}>
                  {market.openEnabled ? "Open for new positions" : "Close-only"}
                </span>
              </div>
              <Toggle
                on={market.openEnabled}
                onColor={C.long}
                disabled={busy || !!notOwner}
                label={`${market.symbol} open for new positions`}
                onChange={() =>
                  run(
                    () => actions.setMarketOpenEnabled(market.id, !market.openEnabled),
                    `${market.symbol} ${market.openEnabled ? "is now close-only" : "reopened"}.`,
                  )
                }
              />
            </div>
          ))}
          <DevNote show={dev}>setMarketOpenEnabled(marketId, enabled)</DevNote>
        </div>

        <div className="tp-card" style={{ gap: 12 }}>
          <span style={{ fontSize: 22, fontWeight: 800 }}>List a market</span>
          <label className="tp-label">
            Symbol
            <input
              value={form.symbol}
              onChange={event => patch({ symbol: event.target.value.toUpperCase() })}
              placeholder="LINK/USD"
            />
          </label>
          <label className="tp-label">
            Chainlink feed
            <input
              className="tp-mono"
              value={form.feed}
              onChange={event => patch({ feed: event.target.value })}
              placeholder="0x…"
              style={{ fontSize: 15 }}
            />
          </label>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
            <label className="tp-label">
              Max leverage
              <input
                value={form.maxLeverage}
                onChange={event => patch({ maxLeverage: event.target.value.replace(/\D/g, "") })}
                inputMode="numeric"
              />
            </label>
            <label className="tp-label">
              Max price age (s)
              <input
                value={form.maxAge}
                onChange={event => patch({ maxAge: event.target.value.replace(/\D/g, "") })}
                inputMode="numeric"
              />
            </label>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <Toggle
              on={form.crossCheck}
              onChange={() => patch({ crossCheck: !form.crossCheck })}
              label="Cross-check against Supra"
            />
            <span style={{ fontWeight: 700, fontSize: 15 }}>Cross-check against Supra</span>
          </div>
          {form.crossCheck && (
            <label className="tp-label">
              Supra pair index
              <input
                value={form.pair}
                onChange={event => patch({ pair: event.target.value.replace(/\D/g, "") })}
                inputMode="numeric"
                placeholder="75"
              />
            </label>
          )}
          <ActionButton
            reason={formReason}
            busy={busy}
            onClick={async () => {
              const listed = await run(
                () =>
                  actions.listMarket(
                    symbol,
                    feed as `0x${string}`,
                    parseInt(form.maxAge, 10),
                    parseInt(form.maxLeverage, 10),
                    form.crossCheck,
                    BigInt(form.pair || "0"),
                  ),
                `Listed ${symbol}.`,
              );
              if (listed) setForm(emptyForm);
            }}
          >
            List market
          </ActionButton>
          <DevNote show={dev}>listMarket(symbol, feed, maxPriceAge, maxLeverage, crossCheck, supraPairIndex)</DevNote>
        </div>

        <div className="tp-card" style={{ background: C.lilac, gap: 12 }}>
          <span style={{ fontSize: 22, fontWeight: 800 }}>Settlement budget</span>
          <span style={{ fontSize: "clamp(40px,5vw,56px)", fontWeight: 800, letterSpacing: "-0.05em", lineHeight: 1 }}>
            {budgetHbar === undefined ? "—" : formatNumber(budgetHbar, 2)} <span style={{ fontSize: 20 }}>HBAR</span>
          </span>
          <span style={{ fontSize: 14, lineHeight: 1.45, textWrap: "pretty" }}>
            The engine pays for scheduled calls. Prepaid fees are held here until each settle runs.
          </span>
          <ActionButton
            reason={notOwner ?? (!budget ? "Nothing to sweep" : null)}
            busy={busy}
            className="tp-btn tp-btn--paper"
            blockedClassName="tp-blocked tp-btn--paper"
            onClick={() =>
              run(
                () => actions.sweepNative(owner!, fromRpcValue(budget ?? 0n, tp.chainId)),
                `Swept ${formatNumber(budgetHbar ?? 0, 2)} HBAR to the owner.`,
              )
            }
          >
            Sweep {budgetHbar === undefined ? "" : formatNumber(budgetHbar, 2)} HBAR to owner
          </ActionButton>
          <DevNote show={dev}>sweepNative(to, amount) · amount in tinybars</DevNote>
        </div>

        <div className="tp-card tp-card--flat" style={{ gap: 4 }}>
          <span style={{ fontSize: 22, fontWeight: 800 }}>Engine parameters</span>
          <span style={{ fontSize: 14, color: "var(--soft)", marginBottom: 8 }}>
            Fixed at deploy. Retuning means redeploying.
          </span>
          {parameters.map(([name, value]) => (
            <div
              key={name}
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 12,
                padding: "8px 0",
                borderTop: "1.5px dashed var(--rule)",
                fontSize: 14,
              }}
            >
              <span className="tp-mono">{name}</span>
              <span style={{ fontWeight: 700, textAlign: "right" }}>{value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
