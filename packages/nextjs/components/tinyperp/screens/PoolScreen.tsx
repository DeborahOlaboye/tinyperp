"use client";

import { useState } from "react";
import { ActionButton, C, DevNote, ScreenProps } from "../ui";
import { collateralToNumber, formatCollateral, formatNumber, parseCollateral } from "~~/utils/tinyperp";

export function PoolScreen({ tp, actions, busy, run, dev }: ScreenProps) {
  const { pool, wallet, config } = tp;
  const [tab, setTab] = useState<"deposit" | "withdraw">("deposit");
  const [text, setText] = useState("");

  const isDeposit = tab === "deposit";
  const amount = parseCollateral(text);
  const poolAssets = pool?.poolAssets ?? 0n;
  const totalShares = pool?.totalShares ?? 0n;
  const sharePrice = totalShares > 0n ? collateralToNumber(poolAssets) / collateralToNumber(totalShares) : 1;

  // The same arithmetic as PerpEngine.previewDeposit and previewWithdraw.
  const sharesOut = totalShares === 0n ? amount : poolAssets === 0n ? 0n : (amount * totalShares) / poolAssets;
  const assetsOut = totalShares === 0n ? 0n : (amount * poolAssets) / totalShares;

  let reason: string | null = null;
  if (!tp.account) reason = "Connect a wallet";
  else if (tp.wrongNetwork) reason = `Switch your wallet to ${tp.network.name}`;
  else if (!pool) reason = "Loading the pool…";
  else if (isDeposit) {
    if (amount <= 0n) reason = "Enter an amount";
    else if (amount > (wallet.collateral ?? 0n)) reason = "Not enough tUSD";
    else if (wallet.association === "none") reason = "Associate tUSD first";
  } else {
    if (amount <= 0n) reason = "Enter shares to burn";
    else if (amount > pool.shares) reason = "More than you hold";
    else if (assetsOut > pool.freeLiquidity) reason = "Exceeds free liquidity";
  }

  const max = isDeposit ? (wallet.collateral ?? 0n) : (pool?.shares ?? 0n);
  const utilisation = pool && pool.poolAssets > 0n ? (Number(pool.reservedAssets) / Number(pool.poolAssets)) * 100 : 0;
  const myPoolShare = pool && totalShares > 0n ? (Number(pool.shares) / Number(totalShares)) * 100 : 0;

  const submit = async () => {
    const done = isDeposit
      ? await run(
          () => actions.deposit(amount),
          `Deposited ${formatCollateral(amount)} tUSD for ${formatCollateral(sharesOut)} shares.`,
        )
      : await run(() => actions.withdraw(amount), `Withdrew ${formatCollateral(assetsOut)} tUSD.`);
    if (done) setText("");
  };

  const tiles = [
    { label: "Pool assets", value: pool ? formatCollateral(pool.poolAssets, 0) : "—", unit: "tUSD", bg: C.lilac },
    {
      label: "Reserved",
      value: pool ? formatCollateral(pool.reservedAssets, 0) : "—",
      unit: "locked by positions",
      bg: C.paper,
    },
    {
      label: "Free liquidity",
      value: pool ? formatCollateral(pool.freeLiquidity, 0) : "—",
      unit: "withdrawable",
      bg: C.long,
    },
    { label: "Share price", value: sharePrice.toFixed(5), unit: "tUSD per share", bg: C.sun },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,210px),1fr))", gap: 14 }}>
        {tiles.map(tile => (
          <div
            key={tile.label}
            style={{
              padding: 18,
              borderRadius: 20,
              border: `2.5px solid ${C.ink}`,
              background: tile.bg,
              boxShadow: `4px 4px 0 ${C.ink}`,
              display: "flex",
              flexDirection: "column",
              gap: 4,
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 600 }}>{tile.label}</span>
            <span
              style={{
                fontSize: "clamp(26px,3vw,34px)",
                fontWeight: 800,
                letterSpacing: "-0.04em",
                fontVariantNumeric: "tabular-nums",
                overflowWrap: "anywhere",
              }}
            >
              {tile.value}
            </span>
            <span className="tp-mono" style={{ fontSize: 12 }}>
              {tile.unit}
            </span>
          </div>
        ))}
      </div>

      <div className="tp-card tp-card--flat" style={{ padding: "18px 20px", borderRadius: 20, gap: 10 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 800, fontSize: 17 }}>{utilisation.toFixed(1)}% reserved by open positions</span>
          <span style={{ fontSize: 14, color: "var(--soft)" }}>
            Every position locks {config ? config.maxProfitMultiple.toString() : "4"}× its margin so the pool can always
            pay.
          </span>
        </div>
        <div
          style={{
            height: 22,
            borderRadius: 999,
            border: `2.5px solid ${C.ink}`,
            background: C.long,
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${Math.min(utilisation, 100)}%`,
              background: C.lilac,
              borderRight: utilisation > 0 ? `2.5px solid ${C.ink}` : undefined,
            }}
          />
        </div>
      </div>

      <div className="tp-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,360px),1fr))" }}>
        <div className="tp-card" style={{ background: C.lilac, gap: 12 }}>
          <span style={{ fontSize: 15, fontWeight: 700 }}>Your stake</span>
          <span
            style={{
              fontSize: "clamp(44px,6vw,64px)",
              fontWeight: 800,
              letterSpacing: "-0.05em",
              lineHeight: 1,
              overflowWrap: "anywhere",
            }}
          >
            {pool ? formatCollateral(pool.shareValue) : "—"}
          </span>
          <span className="tp-mono" style={{ fontSize: 14 }}>
            {pool ? formatCollateral(pool.shares) : "—"} shares · {formatNumber(myPoolShare)}% of pool
          </span>
          <span style={{ fontSize: 14, lineHeight: 1.45, textWrap: "pretty" }}>
            Open fees go straight into the pool, so the share price climbs as people trade. When traders win, the pool
            pays. Shares live inside the engine and can’t be transferred.
          </span>
        </div>

        <div className="tp-card" style={{ gap: 16 }}>
          <div className="tp-seg">
            {(["deposit", "withdraw"] as const).map(option => (
              <button
                key={option}
                type="button"
                aria-pressed={tab === option}
                onClick={() => {
                  setTab(option);
                  setText("");
                }}
              >
                {option === "deposit" ? "Deposit" : "Withdraw"}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 14 }}>
            <label htmlFor="tp-pool-amount" style={{ fontWeight: 700 }}>
              {isDeposit ? "Amount" : "Shares to burn"}
            </label>
            <button
              type="button"
              className="tp-mono tp-link"
              style={{ fontSize: 13 }}
              onClick={() => setText(String(Math.floor(collateralToNumber(max) * 100) / 100))}
            >
              max {formatCollateral(max)}
            </button>
          </div>
          <div className="tp-field">
            <input
              id="tp-pool-amount"
              value={text}
              onChange={event => setText(event.target.value.replace(/[^0-9.]/g, ""))}
              inputMode="decimal"
              placeholder="0"
              style={{ fontSize: 32 }}
            />
            <span style={{ fontWeight: 800, fontSize: 17 }}>{isDeposit ? "tUSD" : "shares"}</span>
          </div>
          <div
            className="tp-rule-row"
            style={{ fontSize: 15, padding: "10px 0", borderTop: `2px solid ${C.ink}`, gap: 10 }}
          >
            <span style={{ color: "var(--soft)" }}>You receive</span>
            <span className="tp-mono" style={{ fontWeight: 500 }}>
              {isDeposit ? `${formatCollateral(sharesOut)} shares` : `${formatCollateral(assetsOut)} tUSD`}
            </span>
          </div>
          <ActionButton
            reason={reason}
            busy={busy}
            onClick={submit}
            className="tp-btn"
            style={{ padding: 16, borderRadius: 16, fontSize: 19, boxShadow: `4px 4px 0 ${C.lilac}` }}
          >
            {isDeposit ? `Deposit ${formatCollateral(amount)} tUSD` : `Withdraw ${formatCollateral(assetsOut)} tUSD`}
          </ActionButton>
          <DevNote show={dev}>{isDeposit ? "deposit(assets)" : "withdraw(shares)"}</DevNote>
        </div>
      </div>
    </div>
  );
}
