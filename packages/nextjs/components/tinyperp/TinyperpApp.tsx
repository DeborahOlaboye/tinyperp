"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Bricolage_Grotesque, DM_Mono } from "next/font/google";
import Link from "next/link";
import { AdminScreen } from "./screens/AdminScreen";
import { ClaimScreen } from "./screens/ClaimScreen";
import { FaucetScreen } from "./screens/FaucetScreen";
import { LiquidationsScreen } from "./screens/LiquidationsScreen";
import { MarketsScreen } from "./screens/MarketsScreen";
import { PoolScreen } from "./screens/PoolScreen";
import { PositionsScreen } from "./screens/PositionsScreen";
import { Ticket, TradeScreen, initialTicket } from "./screens/TradeScreen";
import "./tinyperp.css";
import { C, ScreenKey, ScreenProps, ToastProvider, useRunner } from "./ui";
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { Tinyperp, useNow, useTinyperp, useTinyperpActions } from "~~/hooks/tinyperp";
import { formatCollateral, formatNumber, isPriced, marketStatus, outcomeAt, shortAddress } from "~~/utils/tinyperp";

const display = Bricolage_Grotesque({ subsets: ["latin"], variable: "--tp-display", display: "swap" });
const mono = DM_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--tp-mono", display: "swap" });

/** Show the contract call behind each control. Set to false for a cleaner end-user build. */
const DEV_NOTES = true;

const NAV: { key: ScreenKey; label: string; short?: string; dot: string }[] = [
  { key: "trade", label: "Trade", dot: C.sun },
  { key: "positions", label: "Positions", dot: C.long },
  { key: "pool", label: "Pool", dot: C.lilac },
  { key: "liquidate", label: "Liquidations", short: "Liquidate", dot: C.short },
  { key: "faucet", label: "Faucet", dot: C.long },
  { key: "markets", label: "Markets", dot: C.sun },
  { key: "claim", label: "Claim", dot: C.lilac },
  { key: "admin", label: "Admin", dot: C.paper },
];
const PRIMARY = NAV.slice(0, 4);
const SECONDARY = NAV.slice(4);

/** Eyebrow, title and subtitle for each screen. */
const COPY: Record<ScreenKey, (tp: Tinyperp) => [string, string, string]> = {
  trade: () => [
    "PerpEngine.openPosition",
    "Pick a side.",
    "Leveraged longs and shorts, priced by Chainlink and checked against Supra.",
  ],
  positions: () => [
    "openPositionIdsOf · getPosition",
    "Your positions.",
    "Close any time. Positions with auto-settle pay out on their own at expiry.",
  ],
  pool: () => [
    "deposit · withdraw",
    "Be the house.",
    "Deposit tUSD, collect open fees, take the other side of every trade.",
  ],
  liquidate: ({ config }) => [
    "liquidate(positionId)",
    "Liquidations.",
    `Anything at or under ${config ? Number(config.liquidationThresholdBps) / 100 : 10}% health can be closed by anyone. You keep ${
      config ? Number(config.liquidatorRewardBps) / 100 : 5
    }% of its margin.`,
  ],
  faucet: ({ drip }) => [
    "TestUSD.drip",
    "Get some tUSD.",
    `Associate the token, then drip ${drip ? formatCollateral(drip.dripAmount, 0) : ""} testnet tUSD a day.`,
  ],
  markets: ({ guard }) => [
    "markPrice · OracleLib",
    "Oracle health.",
    `Chainlink sets every price. Supra halts a market when the two disagree by more than ${
      guard ? Number(guard.maxDeviationBps) / 100 : 1
    }%.`,
  ],
  claim: () => ["claim()", "Claim payouts.", "Payouts that couldn’t be delivered wait here until you collect them."],
  admin: () => [
    "onlyOwner",
    "Owner controls.",
    "List markets, switch them to close-only, manage the settlement budget.",
  ],
};

const isScreen = (value: string): value is ScreenKey => NAV.some(item => item.key === value);

export function TinyperpApp() {
  const tp = useTinyperp();
  return (
    <div className={`tp-root ${display.variable} ${mono.variable}`}>
      <ToastProvider explorerUrl={tp.network.blockExplorers?.default.url}>
        <Shell tp={tp} />
      </ToastProvider>
    </div>
  );
}

function Shell({ tp }: { tp: Tinyperp }) {
  const actions = useTinyperpActions(tp);
  const now = useNow();
  const { busy, run } = useRunner();
  const [screen, setScreen] = useState<ScreenKey>("trade");
  const [moreOpen, setMoreOpen] = useState(false);
  const [ticket, setTicketState] = useState<Ticket>(initialTicket);
  const setTicket = useCallback((patch: Partial<Ticket>) => setTicketState(current => ({ ...current, ...patch })), []);

  // Keep the open screen in the URL hash so a reload or a shared link lands in the same place.
  useEffect(() => {
    const fromHash = window.location.hash.slice(1);
    if (isScreen(fromHash)) setScreen(fromHash);
  }, []);
  const go = useCallback((next: ScreenKey) => {
    setScreen(next);
    setMoreOpen(false);
    window.history.replaceState(null, "", `#${next}`);
    window.scrollTo(0, 0);
  }, []);

  const liquidatable = useMemo(() => {
    const { config, guard, markets, openPositions } = tp;
    if (!config) return 0;
    return openPositions.filter(position => {
      const market = markets[Number(position.marketId)];
      if (!market?.price || !isPriced(marketStatus(market, guard, now))) return false;
      return outcomeAt(position, market.price, config).liquidatable;
    }).length;
  }, [tp, now]);

  const badges: Partial<Record<ScreenKey, { text: string; bg: string }>> = {
    ...(tp.positions.length ? { positions: { text: String(tp.positions.length), bg: C.long } } : {}),
    ...(liquidatable ? { liquidate: { text: String(liquidatable), bg: C.short } } : {}),
    ...(tp.claimable > 0n ? { claim: { text: "!", bg: C.lilac } } : {}),
  };

  const [eyebrow, title, sub] = COPY[screen](tp);
  const props: ScreenProps = { tp, actions, now, busy, run, go, dev: DEV_NOTES };
  const inMore = SECONDARY.some(item => item.key === screen);
  const explorer = tp.network.blockExplorers?.default.url;

  return (
    <>
      <aside className="tp-aside">
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0 6px" }}>
          <div className="tp-brand-dot" style={{ width: 30, height: 30, boxShadow: `2px 2px 0 ${C.ink}` }} />
          <div className="tp-brand" style={{ fontSize: 30 }}>
            tinyperp
          </div>
        </div>
        <nav style={{ display: "flex", flexDirection: "column", gap: 6 }} aria-label="Sections">
          {NAV.map(item => (
            <button
              key={item.key}
              type="button"
              className="tp-nav-item"
              aria-current={screen === item.key ? "page" : undefined}
              onClick={() => go(item.key)}
            >
              <span className="tp-dot" style={{ background: item.dot }} />
              <span style={{ flex: 1 }}>{item.label}</span>
              {badges[item.key] && (
                <span className="tp-mono tp-badge" style={{ background: badges[item.key]!.bg }}>
                  {badges[item.key]!.text}
                </span>
              )}
            </button>
          ))}
        </nav>
        <div style={{ marginTop: "auto", display: "flex", flexDirection: "column", gap: 10, padding: "0 6px" }}>
          <div className="tp-mono" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13 }}>
            <span className="tp-live-dot" />
            {tp.network.name}
          </div>
          <div style={{ fontSize: 13, color: "var(--muted)", lineHeight: 1.4, textWrap: "pretty" }}>
            Template code. Not audited. Use testnet funds only.
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 13 }}>
            {tp.engine && explorer && (
              <a href={`${explorer}/contract/${tp.engine.address}`} target="_blank" rel="noreferrer">
                Engine on HashScan
              </a>
            )}
            <Link href="/debug">Debug contracts</Link>
          </div>
        </div>
      </aside>

      <main className="tp-main">
        <div className="tp-wrap">
          <header
            style={{
              display: "flex",
              flexWrap: "wrap",
              alignItems: "flex-end",
              justifyContent: "space-between",
              gap: 18,
            }}
          >
            <div style={{ display: "flex", flexDirection: "column", gap: 8, minWidth: 0, flex: "1 1 320px" }}>
              <div className="tp-narrow" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <div className="tp-brand-dot" style={{ width: 22, height: 22 }} />
                <div className="tp-brand" style={{ fontSize: 24 }}>
                  tinyperp
                </div>
              </div>
              <div className="tp-mono" style={{ fontSize: 13, color: "var(--muted)" }}>
                {eyebrow}
              </div>
              <h1 className="tp-title">{title}</h1>
              <p className="tp-sub">{sub}</p>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" }}>
              <div className="tp-chip">
                <span className="tp-mono" style={{ fontSize: 15, fontWeight: 500 }}>
                  {tp.wallet.collateral === undefined ? "—" : formatCollateral(tp.wallet.collateral)}
                </span>
                <span style={{ fontSize: 13, fontWeight: 700 }}>tUSD</span>
              </div>
              <div className="tp-chip">
                <span className="tp-mono" style={{ fontSize: 15, fontWeight: 500 }}>
                  {tp.wallet.native === undefined ? "—" : formatNumber(Number(tp.wallet.native) / 1e18, 1)}
                </span>
                <span style={{ fontSize: 13, fontWeight: 700 }}>HBAR</span>
              </div>
              <WalletPill wrongNetwork={tp.wrongNetwork} />
            </div>
          </header>

          {!tp.isDeployed && (
            <div className="tp-level" style={{ background: C.sun, fontWeight: 700 }}>
              PerpEngine is not deployed on {tp.network.name}. Run the deploy command for this network, then reload.
            </div>
          )}

          {screen === "trade" && <TradeScreen {...props} ticket={ticket} setTicket={setTicket} />}
          {screen === "positions" && <PositionsScreen {...props} />}
          {screen === "pool" && <PoolScreen {...props} />}
          {screen === "liquidate" && <LiquidationsScreen {...props} />}
          {screen === "faucet" && <FaucetScreen {...props} />}
          {screen === "markets" && <MarketsScreen {...props} />}
          {screen === "claim" && <ClaimScreen {...props} />}
          {screen === "admin" && <AdminScreen {...props} />}
        </div>
      </main>

      <nav className="tp-tabs tp-narrow" aria-label="Sections">
        {PRIMARY.map(item => (
          <button
            key={item.key}
            type="button"
            className="tp-tab"
            aria-current={screen === item.key ? "page" : undefined}
            onClick={() => go(item.key)}
          >
            <span className="tp-dot" style={{ background: item.dot }} />
            {item.short ?? item.label}
          </button>
        ))}
        <button
          type="button"
          className="tp-tab"
          aria-current={inMore || moreOpen ? "page" : undefined}
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(open => !open)}
        >
          <span className="tp-dot" style={{ background: C.paper }} />
          More
        </button>
      </nav>
      {moreOpen && (
        <>
          <button
            type="button"
            className="tp-scrim tp-narrow"
            aria-label="Close menu"
            onClick={() => setMoreOpen(false)}
          />
          <div className="tp-more tp-narrow">
            {SECONDARY.map(item => (
              <button
                key={item.key}
                type="button"
                className="tp-more-item"
                aria-current={screen === item.key ? "page" : undefined}
                onClick={() => go(item.key)}
              >
                <span className="tp-dot" style={{ background: item.dot }} />
                {item.label}
              </button>
            ))}
          </div>
        </>
      )}
    </>
  );
}

/** The wallet button in the header: connect, switch network, or the connected address. */
function WalletPill({ wrongNetwork }: { wrongNetwork: boolean }) {
  return (
    <ConnectButton.Custom>
      {({ account, chain, mounted, openAccountModal, openChainModal, openConnectModal }) => {
        if (!mounted || !account) {
          return (
            <button type="button" className="tp-wallet" onClick={openConnectModal} style={{ fontWeight: 800 }}>
              Connect wallet
            </button>
          );
        }
        if (chain?.unsupported || wrongNetwork) {
          return (
            <button type="button" className="tp-wallet" onClick={openChainModal} style={{ background: C.short }}>
              Wrong network
            </button>
          );
        }
        return (
          <button type="button" className="tp-mono tp-wallet" onClick={openAccountModal}>
            <span className="tp-live-dot" />
            {shortAddress(account.address)}
          </button>
        );
      }}
    </ConnectButton.Custom>
  );
}
