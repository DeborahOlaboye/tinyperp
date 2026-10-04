"use client";

import { ActionButton, C, DevNote, ScreenProps } from "../ui";
import { formatCollateral } from "~~/utils/tinyperp";

export function ClaimScreen({ tp, actions, busy, run, dev }: ScreenProps) {
  const { claimable, wallet, account } = tp;

  let reason: string | null = null;
  if (!account) reason = "Connect a wallet";
  else if (tp.wrongNetwork) reason = `Switch your wallet to ${tp.network.name}`;
  else if (claimable === 0n) reason = "Nothing to claim";
  else if (wallet.association === "none") reason = "Associate tUSD to claim";

  return (
    <div className="tp-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,340px),1fr))" }}>
      <div className="tp-card" style={{ background: C.lilac, padding: 24, gap: 14 }}>
        <span style={{ fontWeight: 700, fontSize: 15 }}>Waiting for you</span>
        <span
          style={{
            fontSize: "clamp(52px,8vw,84px)",
            fontWeight: 800,
            letterSpacing: "-0.05em",
            lineHeight: 0.95,
            overflowWrap: "anywhere",
          }}
        >
          {formatCollateral(claimable)}
        </span>
        <span style={{ fontWeight: 700 }}>tUSD</span>
        <ActionButton
          reason={reason}
          busy={busy}
          onClick={() => run(() => actions.claim(), `Claimed ${formatCollateral(claimable)} tUSD.`)}
          blockedClassName="tp-blocked tp-btn--paper"
          style={{ padding: 16, borderRadius: 16, fontSize: 19 }}
        >
          Claim all
        </ActionButton>
        <DevNote show={dev}>claim() · pays out claimable[msg.sender]</DevNote>
      </div>

      <div className="tp-card tp-card--flat" style={{ gap: 10 }}>
        <span style={{ fontSize: 20, fontWeight: 800 }}>Deferred payouts</span>
        <span style={{ fontSize: 14, color: "var(--soft)", lineHeight: 1.45, textWrap: "pretty" }}>
          Settlement always completes. If tUSD couldn’t reach your account, usually because it wasn’t associated, the
          payout lands here.
        </span>
        {claimable > 0n ? (
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              gap: 12,
              padding: "12px 0",
              borderTop: "1.5px dashed var(--rule)",
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
              <span style={{ fontWeight: 700 }}>Held by the engine</span>
              <span style={{ fontSize: 13, color: "var(--muted)" }}>from positions that settled without you</span>
            </div>
            <span className="tp-mono" style={{ fontWeight: 500 }}>
              {formatCollateral(claimable)} tUSD
            </span>
          </div>
        ) : (
          <span style={{ padding: "12px 0", borderTop: "1.5px dashed var(--rule)", color: "var(--muted)" }}>
            Nothing deferred.
          </span>
        )}
      </div>
    </div>
  );
}
