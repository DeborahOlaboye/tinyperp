"use client";

import { ActionButton, C, DevNote, ScreenProps, Toggle, priceBar } from "../ui";
import {
  BPS,
  GAS,
  WEIBAR_PER_TINYBAR,
  collateralToNumber,
  deviationBps,
  entryPriceFor,
  formatAge,
  formatCollateral,
  formatDuration,
  formatNumber,
  formatPrice,
  isPriced,
  marketStatus,
  parseCollateral,
  priceToNumber,
  quoteOpen,
  toRpcValue,
} from "~~/utils/tinyperp";

export type Ticket = {
  marketId: number;
  isLong: boolean;
  collateral: string;
  leverage: number;
  term: number;
  autoSettle: boolean;
};

export const initialTicket: Ticket = {
  marketId: 0,
  isLong: true,
  collateral: "100",
  leverage: 5,
  term: 3600,
  autoSettle: true,
};

const TERMS = [120, 3600, 86_400, 604_800];
const QUICK_AMOUNTS = ["25", "100", "500"];

export const STATUS_COLOR = {
  Live: C.long,
  "Close-only": C.lilac,
  Halted: C.short,
  Stale: C.dim,
  "No price": C.dim,
} as const;

const bpsToPercent = (bps: bigint) => `${(Number(bps) / 100).toFixed(2)}%`;

export function TradeScreen({
  tp,
  actions,
  now,
  busy,
  run,
  go,
  dev,
  ticket,
  setTicket,
}: ScreenProps & { ticket: Ticket; setTicket: (patch: Partial<Ticket>) => void }) {
  const { markets, config, guard, pool, wallet } = tp;
  const market = markets[ticket.marketId] ?? markets[0];

  if (!market || !config) {
    return (
      <div className="tp-card tp-card--flat" style={{ borderStyle: "dashed", alignItems: "center", padding: 40 }}>
        <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.03em", textAlign: "center" }}>
          {tp.isDeployed ? "Loading markets…" : `PerpEngine is not deployed on ${tp.network.name}.`}
        </div>
      </div>
    );
  }

  const status = marketStatus(market, guard, now);
  const deviation = deviationBps(market, guard, now);
  const maxLeverage = Number(market.maxLeverage);
  const leverage = Math.min(ticket.leverage, maxLeverage);

  const collateral = parseCollateral(ticket.collateral);
  const quote = quoteOpen(collateral, BigInt(leverage), config);
  const entryPrice = market.price ? entryPriceFor(market.price, ticket.isLong, config) : undefined;
  const bar = priceBar(entryPrice ? priceToNumber(entryPrice) : 0, ticket.isLong, leverage, config);

  const terms = TERMS.filter(term => term >= Number(config.minDuration) && term <= Number(config.maxDuration));
  const term = terms.includes(ticket.term) ? ticket.term : (terms[0] ?? Number(config.minDuration));

  const settleFee = toRpcValue(config.autoSettleFee, tp.chainId);
  const settleFeeHbar = formatNumber(Number(settleFee) / 1e18, 1);
  // The fee itself plus enough to pay for the gas of booking the schedule.
  const hbarNeeded = settleFee + GAS.openAutoSettle * 100n * WEIBAR_PER_TINYBAR;

  let reason: string | null = null;
  if (!tp.account) reason = "Connect a wallet to trade";
  else if (tp.wrongNetwork) reason = `Switch your wallet to ${tp.network.name}`;
  else if (!isPriced(status)) reason = `${market.symbol} is ${status.toLowerCase()}`;
  else if (status === "Close-only") reason = `${market.symbol} is close-only`;
  else if (wallet.association === "none") reason = "Associate tUSD first";
  else if (collateral < config.minCollateral)
    reason = `Minimum collateral is ${formatCollateral(config.minCollateral, 0)} tUSD`;
  else if (collateral > (wallet.collateral ?? 0n)) reason = "Not enough tUSD. Visit the faucet";
  else if (pool && quote.reserved > pool.freeLiquidity) reason = "The pool can’t reserve that much";
  else if (ticket.autoSettle && (wallet.native ?? 0n) < hbarNeeded)
    reason = `Need about ${formatNumber(Number(hbarNeeded) / 1e18, 1)} HBAR for auto-settle`;

  const needsApproval = (wallet.allowance ?? 0n) < collateral;
  const sideWord = ticket.isLong ? "long" : "short";

  const open = async () => {
    if (!entryPrice) return;
    const opened = await run(
      () =>
        actions.openPosition({
          market,
          isLong: ticket.isLong,
          collateral,
          leverage: BigInt(leverage),
          duration: BigInt(term),
          autoSettle: ticket.autoSettle,
          entryPrice,
        }),
      `Opened a ${leverage}× ${sideWord} on ${market.symbol}${ticket.autoSettle ? ". Settlement booked on 0x16b." : "."}`,
    );
    if (opened) go("positions");
  };

  const breakdown = [
    [`Open fee (${bpsToPercent(config.openFeeBps)} of size)`, `${formatCollateral(quote.fee)} tUSD`],
    ["Margin", `${formatCollateral(quote.margin)} tUSD`],
    ["Position size", `${formatCollateral(quote.size)} tUSD`],
    ["Reserved from pool", `${formatCollateral(quote.reserved)} tUSD`],
    [`Entry price, after ${bpsToPercent(config.spreadBps)} spread`, formatPrice(entryPrice)],
    ["Term", formatDuration(term) + (ticket.autoSettle ? " · auto-settle" : "")],
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div style={{ display: "flex", gap: 12, overflowX: "auto", padding: "2px 8px 10px 2px" }}>
        {markets.map((item, index) => {
          const change =
            item.price && item.previousPrice
              ? (priceToNumber(item.price) / priceToNumber(item.previousPrice) - 1) * 100
              : undefined;
          return (
            <button
              key={item.symbol}
              type="button"
              className="tp-market"
              aria-pressed={index === ticket.marketId}
              onClick={() =>
                setTicket({ marketId: index, leverage: Math.min(ticket.leverage, Number(item.maxLeverage)) })
              }
            >
              <span style={{ display: "flex", alignItems: "center", gap: 8, width: "100%" }}>
                <span style={{ fontSize: 16, fontWeight: 800 }}>{item.symbol}</span>
                {change !== undefined && (
                  <span
                    className="tp-mono"
                    title="Change since the previous Chainlink round"
                    style={{
                      marginLeft: "auto",
                      fontSize: 11,
                      padding: "1px 7px",
                      borderRadius: 999,
                      background: change >= 0 ? C.long : C.short,
                      border: `1.5px solid ${C.ink}`,
                    }}
                  >
                    {change >= 0 ? "+" : "−"}
                    {Math.abs(change).toFixed(2)}%
                  </span>
                )}
              </span>
              <span className="tp-mono" style={{ fontSize: 18, fontWeight: 500 }}>
                {formatPrice(item.price)}
              </span>
            </button>
          );
        })}
      </div>

      <div className="tp-grid" style={{ gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,400px),1fr))" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 22, minWidth: 0 }}>
          <div className="tp-card" style={{ background: C.sun, gap: 10 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
              <span style={{ fontSize: 20, fontWeight: 800 }}>{market.symbol}</span>
              <span className="tp-mono tp-pill" style={{ background: STATUS_COLOR[status] }}>
                {status}
              </span>
              <span className="tp-mono" style={{ marginLeft: "auto", fontSize: 13 }}>
                max {maxLeverage}×
              </span>
            </div>
            <div
              style={{
                fontSize: "clamp(52px,9vw,104px)",
                fontWeight: 800,
                letterSpacing: "-0.05em",
                lineHeight: 0.95,
                fontVariantNumeric: "tabular-nums",
                overflowWrap: "anywhere",
              }}
            >
              {formatPrice(market.price)}
            </div>
            <div className="tp-mono" style={{ display: "flex", flexWrap: "wrap", gap: "8px 18px", fontSize: 13 }}>
              <span>Chainlink {formatPrice(market.price)}</span>
              <span>Supra {market.crossCheck ? formatPrice(market.supraPrice) : "not checked"}</span>
              <span>Δ {deviation === undefined ? "—" : `${Math.round(deviation)} bps`}</span>
              <span>updated {market.updatedAt ? formatAge(now - Number(market.updatedAt)) : "—"} ago</span>
            </div>
          </div>

          <div className="tp-card" style={{ gap: 8 }}>
            <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: "-0.03em" }}>Where this lands</div>
            <div style={{ fontSize: 15, color: "var(--muted)" }}>
              {ticket.isLong ? "A long" : "A short"} {leverage}× across every possible price, worst case to cap.
            </div>
            <div style={{ position: "relative", height: 44, margin: "46px 34px 56px" }}>
              <div
                style={{
                  position: "absolute",
                  inset: 0,
                  borderRadius: 999,
                  border: `2.5px solid ${C.ink}`,
                  background: bar.gradient,
                }}
              />
              {[
                { left: bar.liquidationLeft, width: 3, inset: -8 },
                { left: bar.entryLeft, width: 5, inset: -10 },
                { left: bar.capLeft, width: 3, inset: -8 },
              ].map((mark, index) => (
                <div
                  key={index}
                  style={{
                    position: "absolute",
                    left: mark.left,
                    top: mark.inset,
                    bottom: mark.inset,
                    width: mark.width,
                    borderRadius: 3,
                    background: C.ink,
                    transform: "translateX(-50%)",
                  }}
                />
              ))}
              <div
                className="tp-mono"
                style={{
                  position: "absolute",
                  left: bar.entryLeft,
                  bottom: "calc(100% + 14px)",
                  transform: "translateX(-50%)",
                  fontSize: 12,
                  whiteSpace: "nowrap",
                  padding: "2px 8px",
                  borderRadius: 999,
                  background: C.ink,
                  color: C.paper,
                }}
              >
                entry {bar.entry}
              </div>
              {[
                { left: bar.liquidationLeft, label: "liquidation", value: bar.liquidation },
                { left: bar.capLeft, label: "profit cap", value: bar.cap },
              ].map(mark => (
                <div
                  key={mark.label}
                  className="tp-mono"
                  style={{
                    position: "absolute",
                    left: mark.left,
                    top: "calc(100% + 14px)",
                    transform: "translateX(-50%)",
                    fontSize: 12,
                    whiteSpace: "nowrap",
                    textAlign: "center",
                    lineHeight: 1.3,
                  }}
                >
                  {mark.label}
                  <br />
                  {mark.value}
                </div>
              ))}
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div className="tp-level" style={{ background: C.short }}>
                <span style={{ fontWeight: 700, flex: 1 }}>Anyone can liquidate at</span>
                <span className="tp-mono">{bar.liquidation}</span>
              </div>
              <div className="tp-level" style={{ background: C.bg }}>
                <span style={{ fontWeight: 700, flex: 1 }}>Margin fully gone at</span>
                <span className="tp-mono">{bar.zero}</span>
              </div>
              <div className="tp-level" style={{ background: C.long }}>
                <span style={{ fontWeight: 700, flex: 1 }}>
                  Payout caps at {formatCollateral(quote.margin + quote.reserved)} tUSD from
                </span>
                <span className="tp-mono">{bar.cap}</span>
              </div>
            </div>
          </div>
        </div>

        <div className="tp-card" style={{ gap: 22 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <button
              type="button"
              className="tp-side"
              aria-pressed={ticket.isLong}
              style={ticket.isLong ? { background: C.long } : undefined}
              onClick={() => setTicket({ isLong: true })}
            >
              Long<span>Price goes up</span>
            </button>
            <button
              type="button"
              className="tp-side"
              aria-pressed={!ticket.isLong}
              style={ticket.isLong ? undefined : { background: C.short }}
              onClick={() => setTicket({ isLong: false })}
            >
              Short<span>Price goes down</span>
            </button>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 15 }}>
              <label htmlFor="tp-collateral" style={{ fontWeight: 700 }}>
                Collateral
              </label>
              <span className="tp-mono" style={{ fontSize: 13, color: "var(--muted)" }}>
                bal {wallet.collateral === undefined ? "—" : formatCollateral(wallet.collateral)}
              </span>
            </div>
            <div className="tp-field">
              <input
                id="tp-collateral"
                value={ticket.collateral}
                onChange={event => setTicket({ collateral: event.target.value.replace(/[^0-9.]/g, "") })}
                inputMode="decimal"
                style={{ fontSize: 34 }}
              />
              <span style={{ fontWeight: 800, fontSize: 18 }}>tUSD</span>
            </div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {QUICK_AMOUNTS.map(amount => (
                <button
                  key={amount}
                  type="button"
                  className="tp-mono tp-quick"
                  onClick={() => setTicket({ collateral: amount })}
                >
                  {amount}
                </button>
              ))}
              <button
                type="button"
                className="tp-mono tp-quick"
                onClick={() =>
                  setTicket({ collateral: String(Math.floor(collateralToNumber(wallet.collateral ?? 0n) * 100) / 100) })
                }
              >
                Max
              </button>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
              <label htmlFor="tp-leverage" style={{ fontWeight: 700, fontSize: 15 }}>
                Leverage
              </label>
              <span style={{ fontSize: 40, fontWeight: 800, letterSpacing: "-0.04em", lineHeight: 1 }}>
                {leverage}×
              </span>
            </div>
            <input
              id="tp-leverage"
              type="range"
              min={1}
              max={maxLeverage}
              step={1}
              value={leverage}
              onChange={event => setTicket({ leverage: parseInt(event.target.value, 10) })}
              style={{ width: "100%", height: 28 }}
            />
            <div
              className="tp-mono"
              style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "var(--muted)" }}
            >
              <span>1×</span>
              <span>{maxLeverage}×</span>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <span style={{ fontWeight: 700, fontSize: 15 }}>Term</span>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(70px,1fr))", gap: 8 }}>
              {terms.map(option => (
                <button
                  key={option}
                  type="button"
                  className="tp-choice"
                  aria-pressed={option === term}
                  onClick={() => setTicket({ term: option })}
                >
                  {formatDuration(option)}
                </button>
              ))}
            </div>
          </div>

          <div
            style={{
              display: "flex",
              gap: 14,
              alignItems: "flex-start",
              padding: 14,
              borderRadius: 14,
              border: `2px dashed ${C.ink}`,
            }}
          >
            <Toggle
              on={ticket.autoSettle}
              onChange={() => setTicket({ autoSettle: !ticket.autoSettle })}
              label="Settle itself at expiry"
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
              <span style={{ fontWeight: 800, fontSize: 16 }}>Settle itself at expiry</span>
              <span style={{ fontSize: 14, color: "var(--soft)", lineHeight: 1.4, textWrap: "pretty" }}>
                The Hedera Schedule Service calls settleExpired for you. No bot needed. Costs {settleFeeHbar} HBAR,
                refunded if you close early, and booking it adds about 1.4 million gas to this transaction.
              </span>
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", borderTop: `2px solid ${C.ink}` }}>
            {breakdown.map(([label, value]) => (
              <div key={label} className="tp-rule-row" style={{ padding: "9px 0", fontSize: 15 }}>
                <span style={{ color: "var(--soft)" }}>{label}</span>
                <span className="tp-mono" style={{ fontWeight: 500, textAlign: "right" }}>
                  {value}
                </span>
              </div>
            ))}
          </div>

          <ActionButton
            reason={reason}
            busy={busy}
            onClick={open}
            className="tp-btn tp-btn--big"
            blockedClassName="tp-blocked tp-blocked--big"
            style={{ boxShadow: `4px 4px 0 ${ticket.isLong ? C.long : C.short}` }}
          >
            Open {leverage}× {sideWord} · {formatCollateral(collateral)} tUSD
          </ActionButton>
          {!reason && needsApproval && (
            <span style={{ fontSize: 14, color: "var(--soft)", marginTop: -10, textWrap: "pretty" }}>
              Your wallet will ask twice the first time: once to let the engine pull tUSD, then to open.
            </span>
          )}
          <DevNote show={dev}>
            openPosition({ticket.marketId}, {String(ticket.isLong)}, {collateral.toString()}, {leverage}, {term},{" "}
            {entryPrice ? formatPrice((entryPrice * (ticket.isLong ? BPS + 50n : BPS - 50n)) / BPS) : "acceptablePrice"}
            , {String(ticket.autoSettle)}){ticket.autoSettle ? ` · value ${settleFeeHbar} HBAR` : ""}
          </DevNote>
        </div>
      </div>
    </div>
  );
}
