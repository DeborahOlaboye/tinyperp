"use client";

import { ActionButton, C, DevNote, ScreenProps, useToast } from "../ui";
import { formatCollateral, formatCountdown, formatDuration, formatNumber, toRpcValue } from "~~/utils/tinyperp";

const stepStyle = {
  width: 44,
  height: 44,
  borderRadius: "50%",
  border: `2.5px solid ${C.ink}`,
  background: C.paper,
  display: "grid",
  placeItems: "center",
  fontWeight: 800,
  fontSize: 20,
} as const;

const headingStyle = { fontSize: 28, fontWeight: 800, letterSpacing: "-0.03em", lineHeight: 1.05 } as const;
const bodyStyle = { fontSize: 15, lineHeight: 1.45, textWrap: "pretty" } as const;

export function FaucetScreen({ tp, actions, now, busy, run, dev }: ScreenProps) {
  const toast = useToast();
  const { wallet, drip, config, account } = tp;

  const canHold = wallet.association === "associated" || wallet.association === "automatic";
  const amount = drip ? formatCollateral(drip.dripAmount, 0) : "—";
  const nextDripAt = Number(drip?.nextDripAt ?? 0n);

  let dripReason: string | null = null;
  if (!account) dripReason = "Connect a wallet";
  else if (tp.wrongNetwork) dripReason = `Switch your wallet to ${tp.network.name}`;
  else if (!drip) dripReason = "The faucet is not deployed here";
  else if (wallet.association === "none") dripReason = "Associate first";
  else if (now < nextDripAt) dripReason = `Next drip in ${formatCountdown(nextDripAt - now)}`;

  const dissociate = () => {
    // Hedera refuses to dissociate an account that still holds the token.
    if ((wallet.collateral ?? 0n) > 0n) {
      toast({
        text: "Hedera only lets an account dissociate at a zero balance. Move your tUSD out first.",
        error: true,
      });
      return;
    }
    run(() => actions.dissociate(), "Dissociated. Payouts will be deferred to Claim.");
  };

  const settleFee = config?.autoSettleFee ?? 0n;

  return (
    <div className="tp-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,320px),1fr))" }}>
      <div className="tp-card" style={{ background: canHold ? C.long : C.paper, gap: 14 }}>
        <span style={stepStyle}>1</span>
        <span style={headingStyle}>Associate tUSD</span>
        <span style={bodyStyle}>
          On Hedera an account has to opt in to a token before it can hold it. Most EVM wallets have free
          auto-association slots and skip this.
        </span>
        {wallet.association === "associated" && (
          <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
            <span className="tp-btn tp-btn--paper" style={{ padding: "10px 16px", borderRadius: 12 }}>
              ✓ Associated
            </span>
            <button type="button" className="tp-link" disabled={busy} onClick={dissociate}>
              Dissociate to test deferred payouts
            </button>
          </div>
        )}
        {wallet.association === "automatic" && (
          <span className="tp-btn tp-btn--paper" style={{ padding: "10px 16px", borderRadius: 12 }}>
            ✓ Auto-association slot free. Nothing to do.
          </span>
        )}
        {!canHold && (
          <ActionButton
            reason={!account ? "Connect a wallet" : tp.wrongNetwork ? `Switch your wallet to ${tp.network.name}` : null}
            busy={busy}
            onClick={() => run(() => actions.associate(), "Associated with tUSD. You can hold it now.")}
          >
            Associate tUSD
          </ActionButton>
        )}
        <DevNote show={dev}>associate() on the token address{tp.token ? ` ${tp.token}` : ""}</DevNote>
      </div>

      <div className="tp-card" style={{ background: C.sun, gap: 14 }}>
        <span style={stepStyle}>2</span>
        <span style={headingStyle}>Drip {amount} tUSD</span>
        <span style={bodyStyle}>
          The TestUSD contract is the token’s treasury and mints straight from Solidity.{" "}
          {!drip || drip.dripCooldown === 86_400n
            ? "Once every 24 hours."
            : `Once every ${formatDuration(Number(drip.dripCooldown))}.`}
        </span>
        <ActionButton
          reason={dripReason}
          busy={busy}
          onClick={() => run(() => actions.drip(), `Dripped ${amount} tUSD from the faucet.`)}
          blockedClassName="tp-blocked tp-btn--paper"
        >
          Drip {amount} tUSD
        </ActionButton>
        <DevNote show={dev}>TestUSD.drip() · reverts HtsTransferFailed(184) if not associated</DevNote>
      </div>

      <div className="tp-card tp-card--flat" style={{ gap: 12 }}>
        <span style={{ fontSize: 20, fontWeight: 800 }}>Hedera quirks worth knowing</span>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, fontSize: 14, lineHeight: 1.45 }}>
          <div style={{ paddingBottom: 10, borderBottom: "1.5px dashed var(--rule)" }}>
            <b>HBAR has two sizes.</b> 8 decimals inside contracts (tinybars), 18 over JSON-RPC (weibars). The{" "}
            {formatNumber(Number(settleFee) / 1e8, 1)} HBAR settle fee is{" "}
            <span className="tp-mono">{settleFee.toLocaleString("en-US")}</span> tinybars, sent as{" "}
            <span className="tp-mono">{toRpcValue(settleFee, 296).toLocaleString("en-US")}</span> weibars.
          </div>
          <div style={{ paddingBottom: 10, borderBottom: "1.5px dashed var(--rule)" }}>
            <b>Payouts never get stuck.</b> If a transfer to you fails, it’s parked under Claim instead.
          </div>
          <div>
            <b>Response code 22 means success.</b> System contracts return codes instead of reverting.
          </div>
        </div>
      </div>
    </div>
  );
}
