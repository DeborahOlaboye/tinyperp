import { Address, formatUnits, parseUnits } from "viem";

/**
 * Types, constants and pure helpers for talking to PerpEngine. No React in here: the hooks in
 * `hooks/tinyperp` read the chain and hand these shapes to the UI.
 */

export const COLLATERAL_DECIMALS = 6;
export const PRICE_DECIMALS = 18;
export const BPS = 10_000n;

export const HEDERA_CHAIN_IDS: readonly number[] = [295, 296];
/** JSON-RPC values are in weibars (18 decimals); the contract sees tinybars (8 decimals). */
export const WEIBAR_PER_TINYBAR = 10_000_000_000n;

/**
 * Gas limits, set by hand because wallets underestimate calls that reach Hedera system contracts.
 * Each is the gas measured on testnet plus headroom. Hedera charges for the gas used, not the limit.
 */
export const GAS = {
  associate: 1_000_000n, // 726k: HTS association
  approve: 1_000_000n, // 727k: HTS allowance
  drip: 400_000n, // 82k
  open: 800_000n, // 339k
  openAutoSettle: 2_300_000n, // 1.8M: booking a schedule costs about 1.41M
  settle: 600_000n, // 132k, or 202k when a schedule is deleted
  pool: 400_000n, // 113k
  admin: 500_000n,
} as const;

/**
 * Allowance requested the first time the engine needs to pull collateral. An HTS approval costs about
 * 0.6 HBAR, so the app asks once for a large amount instead of before every trade. HTS amounts are int64,
 * which rules out the usual max-uint256.
 */
export const APPROVAL_AMOUNT = 10n ** 15n; // one billion tUSD

export type EngineConfig = {
  openFeeBps: bigint;
  spreadBps: bigint;
  liquidationThresholdBps: bigint;
  liquidatorRewardBps: bigint;
  maxProfitMultiple: bigint;
  minDuration: bigint;
  maxDuration: bigint;
  autoSettleGasLimit: bigint;
  scheduleCallGas: bigint;
  minCollateral: bigint;
  /** In tinybars on Hedera. Pass through `toRpcValue` before sending. */
  autoSettleFee: bigint;
};

export type OracleGuard = {
  supra: Address;
  supraMaxAge: bigint;
  maxDeviationBps: bigint;
};

export type MarketStatus = "Live" | "Close-only" | "Halted" | "Stale" | "No price";

export type Market = {
  id: bigint;
  symbol: string;
  feed: Address;
  feedDecimals: number;
  maxPriceAge: bigint;
  maxLeverage: bigint;
  openEnabled: boolean;
  crossCheck: boolean;
  supraPairIndex: bigint;
  /** Latest Chainlink answer, 18 decimals, whether or not the engine would trade on it. */
  price?: bigint;
  /** When Chainlink published it, in seconds. */
  updatedAt?: bigint;
  /** The round before it, for the change shown next to the price. */
  previousPrice?: bigint;
  /** Latest Supra value, 18 decimals. Only read for cross-checked markets. */
  supraPrice?: bigint;
  supraUpdatedAt?: bigint;
};

export type Position = {
  id: bigint;
  owner: Address;
  marketId: bigint;
  isLong: boolean;
  openedAt: bigint;
  expiresAt: bigint;
  margin: bigint;
  size: bigint;
  reserved: bigint;
  entryPrice: bigint;
  schedule: Address;
  settleDeposit: bigint;
};

export type Outcome = {
  exitPrice: bigint;
  pnl: bigint;
  payout: bigint;
  liquidatable: boolean;
};

type Numeric = bigint | number;
const big = (value: Numeric) => BigInt(value);

/** `PerpEngine.config()` returns its fields as a tuple, in declaration order. */
export function toEngineConfig(raw: readonly Numeric[]): EngineConfig {
  const [
    openFeeBps,
    spreadBps,
    liquidationThresholdBps,
    liquidatorRewardBps,
    maxProfitMultiple,
    minDuration,
    maxDuration,
    autoSettleGasLimit,
    scheduleCallGas,
    minCollateral,
    autoSettleFee,
  ] = raw.map(big);
  return {
    openFeeBps,
    spreadBps,
    liquidationThresholdBps,
    liquidatorRewardBps,
    maxProfitMultiple,
    minDuration,
    maxDuration,
    autoSettleGasLimit,
    scheduleCallGas,
    minCollateral,
    autoSettleFee,
  };
}

export function toOracleGuard(raw: readonly [Address, Numeric, Numeric]): OracleGuard {
  return { supra: raw[0], supraMaxAge: big(raw[1]), maxDeviationBps: big(raw[2]) };
}

export type RawMarket = {
  symbol: string;
  feed: Address;
  feedDecimals: Numeric;
  maxPriceAge: Numeric;
  maxLeverage: Numeric;
  openEnabled: boolean;
  crossCheck: boolean;
  supraPairIndex: Numeric;
};

export function toMarket(id: bigint, raw: RawMarket): Market {
  return {
    id,
    symbol: raw.symbol,
    feed: raw.feed,
    feedDecimals: Number(raw.feedDecimals),
    maxPriceAge: big(raw.maxPriceAge),
    maxLeverage: big(raw.maxLeverage),
    openEnabled: raw.openEnabled,
    crossCheck: raw.crossCheck,
    supraPairIndex: big(raw.supraPairIndex),
  };
}

export type RawPosition = Omit<Position, "id" | "marketId" | "openedAt" | "expiresAt"> & {
  marketId: Numeric;
  openedAt: Numeric;
  expiresAt: Numeric;
};

export function toPosition(id: bigint, raw: RawPosition): Position {
  return {
    id,
    owner: raw.owner,
    marketId: big(raw.marketId),
    isLong: raw.isLong,
    openedAt: big(raw.openedAt),
    expiresAt: big(raw.expiresAt),
    margin: raw.margin,
    size: raw.size,
    reserved: raw.reserved,
    entryPrice: raw.entryPrice,
    schedule: raw.schedule,
    settleDeposit: raw.settleDeposit,
  };
}

/** Rescales an oracle answer to 18 decimals, as `OracleLib.scale` does. */
export function scalePrice(value: bigint, decimals: number): bigint {
  if (decimals === PRICE_DECIMALS) return value;
  return decimals < PRICE_DECIMALS
    ? value * 10n ** BigInt(PRICE_DECIMALS - decimals)
    : value / 10n ** BigInt(decimals - PRICE_DECIMALS);
}

/** Gap between Chainlink and Supra in basis points, or undefined when Supra is not being compared. */
export function deviationBps(market: Market, guard: OracleGuard | undefined, now: number): number | undefined {
  if (!market.crossCheck || !guard || !market.price || !market.supraPrice || !market.supraUpdatedAt) return undefined;
  if (BigInt(now) - market.supraUpdatedAt > guard.supraMaxAge) return undefined;
  const diff = market.price > market.supraPrice ? market.price - market.supraPrice : market.supraPrice - market.price;
  return Number((diff * BPS * 100n) / market.price) / 100;
}

/**
 * Whether the engine would trade this market right now, mirroring `PerpEngine._markPrice`: a stale Chainlink
 * round stops it, and so does a fresh Supra value that disagrees by more than the tolerance.
 */
export function marketStatus(market: Market, guard: OracleGuard | undefined, now: number): MarketStatus {
  if (!market.price || !market.updatedAt) return "No price";
  if (BigInt(now) - market.updatedAt > market.maxPriceAge) return "Stale";
  const deviation = deviationBps(market, guard, now);
  if (deviation !== undefined && guard && deviation > Number(guard.maxDeviationBps)) return "Halted";
  return market.openEnabled ? "Live" : "Close-only";
}

export const isPriced = (status: MarketStatus) => status === "Live" || status === "Close-only";

const withSpread = (price: bigint, spreadBps: bigint, up: boolean) =>
  (price * (up ? BPS + spreadBps : BPS - spreadBps)) / BPS;

/** Entry price for a new position: the oracle price moved against the trader by the spread. */
export const entryPriceFor = (oraclePrice: bigint, isLong: boolean, config: EngineConfig) =>
  withSpread(oraclePrice, config.spreadBps, isLong);

/** What settling a position at `oraclePrice` would pay, mirroring `PerpEngine._payoutAt`. */
export function outcomeAt(position: Position, oraclePrice: bigint, config: EngineConfig): Outcome {
  const exitPrice = withSpread(oraclePrice, config.spreadBps, !position.isLong);
  const delta = position.isLong ? exitPrice - position.entryPrice : position.entryPrice - exitPrice;
  const equity = position.margin + (position.size * delta) / position.entryPrice;
  const cap = position.margin + position.reserved;
  const payout = equity <= 0n ? 0n : equity > cap ? cap : equity;
  return {
    exitPrice,
    pnl: payout - position.margin,
    payout,
    liquidatable: payout * BPS <= position.margin * config.liquidationThresholdBps,
  };
}

/** What an open will cost and reserve, mirroring `PerpEngine._fundPosition`. */
export function quoteOpen(collateral: bigint, leverage: bigint, config: EngineConfig) {
  const fee = (collateral * leverage * config.openFeeBps) / BPS;
  const margin = collateral > fee ? collateral - fee : 0n;
  return { fee, margin, size: margin * leverage, reserved: margin * config.maxProfitMultiple };
}

/**
 * The oracle prices at which a position is liquidatable, wiped out and capped. Display only, so plain
 * numbers: `entry` is the entry price and `leverage` is size over margin.
 */
export function priceLevels(entry: number, isLong: boolean, leverage: number, config: EngineConfig) {
  const spread = Number(config.spreadBps) / 10_000;
  const keep = 1 - Number(config.liquidationThresholdBps) / 10_000;
  const cap = Number(config.maxProfitMultiple);
  if (leverage <= 0) return { liquidation: 0, zero: 0, cap: 0 };
  return isLong
    ? {
        liquidation: (entry * (1 - keep / leverage)) / (1 - spread),
        zero: (entry * (1 - 1 / leverage)) / (1 - spread),
        cap: (entry * (1 + cap / leverage)) / (1 - spread),
      }
    : {
        liquidation: (entry * (1 + keep / leverage)) / (1 + spread),
        zero: (entry * (1 + 1 / leverage)) / (1 + spread),
        cap: Math.max(entry * (1 - cap / leverage), 0) / (1 + spread),
      };
}

/**
 * Converts an amount the contract compares against msg.value into the `value` to send over JSON-RPC.
 * On Hedera that is tinybars to weibars; every other chain passes the value through.
 */
export function toRpcValue(contractValue: bigint, chainId: number): bigint {
  return HEDERA_CHAIN_IDS.includes(chainId) ? contractValue * WEIBAR_PER_TINYBAR : contractValue;
}

/** The reverse: a balance read over JSON-RPC, as the contract would see it. */
export function fromRpcValue(rpcValue: bigint, chainId: number): bigint {
  return HEDERA_CHAIN_IDS.includes(chainId) ? rpcValue / WEIBAR_PER_TINYBAR : rpcValue;
}

/**
 * The worst entry price to accept, given the entry price quoted now and a tolerance. Longs get a ceiling
 * above it and shorts a floor below it.
 */
export function acceptablePrice(entryPrice: bigint, isLong: boolean, toleranceBps: bigint): bigint {
  return (entryPrice * (isLong ? BPS + toleranceBps : BPS - toleranceBps)) / BPS;
}

/** A long-zero EVM address, such as an HTS token's, as a Hedera entity id. */
export const toEntityId = (address: Address) => `0.0.${BigInt(address)}`;

// ---------------------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------------------

export const collateralToNumber = (amount: bigint) => Number(formatUnits(amount, COLLATERAL_DECIMALS));
export const priceToNumber = (price: bigint) => Number(formatUnits(price, PRICE_DECIMALS));

/** Parses what a user typed into the token's smallest unit. Anything unparseable is zero. */
export function parseCollateral(text: string): bigint {
  const cleaned = text.trim();
  if (!/^\d*\.?\d*$/.test(cleaned) || cleaned === "" || cleaned === ".") return 0n;
  const [whole, fraction = ""] = cleaned.split(".");
  return parseUnits(`${whole || "0"}.${fraction.slice(0, COLLATERAL_DECIMALS) || "0"}`, COLLATERAL_DECIMALS);
}

export const formatNumber = (value: number, digits = 2) =>
  value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const formatCollateral = (amount: bigint, digits = 2) => formatNumber(collateralToNumber(amount), digits);

/** Prices span five orders of magnitude between HBAR and BTC, so pick the precision from the size. */
export const formatPriceNumber = (value: number) =>
  value > 0 ? formatNumber(value, value < 1 ? 5 : value < 100 ? 3 : 2) : "—";

export const formatPrice = (price?: bigint) => (price ? formatPriceNumber(priceToNumber(price)) : "—");

export const formatSigned = (value: number) => (value >= 0 ? "+" : "−") + formatNumber(Math.abs(value));

export const shortAddress = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`;

/** "1d 4h", "3h 12m" or "4m 07s". */
export function formatCountdown(seconds: number): string {
  if (seconds <= 0) return "expired";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days) return `${days}d ${hours}h`;
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
}

/** "42s", "3m 10s" or "5.2h". */
export function formatAge(seconds: number): string {
  if (seconds < 0) return "0s";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

export function formatDuration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} day${seconds === 86_400 ? "" : "s"}`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hour${seconds === 3600 ? "" : "s"}`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds}s`;
}

// ---------------------------------------------------------------------------------------------------------
// ABIs for contracts that are not in deployedContracts.ts
// ---------------------------------------------------------------------------------------------------------

/** HIP-719: every HTS token exposes association at its own address. */
export const hip719Abi = [
  {
    type: "function",
    name: "associate",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "responseCode", type: "uint256" }],
  },
  {
    type: "function",
    name: "dissociate",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "responseCode", type: "uint256" }],
  },
] as const;

const roundOutputs = [
  { name: "roundId", type: "uint80" },
  { name: "answer", type: "int256" },
  { name: "startedAt", type: "uint256" },
  { name: "updatedAt", type: "uint256" },
  { name: "answeredInRound", type: "uint80" },
] as const;

export const aggregatorAbi = [
  { type: "function", name: "latestRoundData", stateMutability: "view", inputs: [], outputs: roundOutputs },
  {
    type: "function",
    name: "getRoundData",
    stateMutability: "view",
    inputs: [{ name: "roundId", type: "uint80" }],
    outputs: roundOutputs,
  },
] as const;

export const supraAbi = [
  {
    type: "function",
    name: "getSvalue",
    stateMutability: "view",
    inputs: [{ name: "pairIndex", type: "uint256" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "round", type: "uint256" },
          { name: "decimals", type: "uint256" },
          { name: "time", type: "uint256" },
          { name: "price", type: "uint256" },
        ],
      },
    ],
  },
] as const;
