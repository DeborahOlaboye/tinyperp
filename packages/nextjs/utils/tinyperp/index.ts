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
 * Gas limit for an open that books a scheduled settlement. Booking costs about 1.41 million gas on Hedera
 * and wallets underestimate it, so it is set by hand.
 */
export const AUTO_SETTLE_OPEN_GAS = 2_300_000n;

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

export type Market = {
  id: bigint;
  symbol: string;
  feed: Address;
  maxPriceAge: bigint;
  maxLeverage: bigint;
  openEnabled: boolean;
  crossCheck: boolean;
  /** Oracle price, 18 decimals. Undefined while the feed is stale or the market is halted. */
  price?: bigint;
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
  /** What settling now would produce. Undefined while the market cannot be priced. */
  status?: PositionStatus;
};

export type PositionStatus = {
  exitPrice: bigint;
  pnl: bigint;
  payout: bigint;
  liquidatable: boolean;
  expired: boolean;
};

export type PoolState = {
  poolAssets: bigint;
  reservedAssets: bigint;
  freeLiquidity: bigint;
  totalShares: bigint;
  /** The connected account's shares and what they are worth now. */
  shares: bigint;
  shareValue: bigint;
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

type RawMarket = {
  symbol: string;
  feed: Address;
  maxPriceAge: Numeric;
  maxLeverage: Numeric;
  openEnabled: boolean;
  crossCheck: boolean;
};

export function toMarket(id: bigint, raw: RawMarket, price?: bigint): Market {
  return {
    id,
    symbol: raw.symbol,
    feed: raw.feed,
    maxPriceAge: big(raw.maxPriceAge),
    maxLeverage: big(raw.maxLeverage),
    openEnabled: raw.openEnabled,
    crossCheck: raw.crossCheck,
    price,
  };
}

type RawPosition = Omit<Position, "id" | "marketId" | "openedAt" | "expiresAt" | "status"> & {
  marketId: Numeric;
  openedAt: Numeric;
  expiresAt: Numeric;
};
type RawStatus = readonly [bigint, bigint, bigint, boolean, boolean];

export function toPosition(id: bigint, raw: RawPosition, status?: RawStatus): Position {
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
    status: status && {
      exitPrice: status[0],
      pnl: status[1],
      payout: status[2],
      liquidatable: status[3],
      expired: status[4],
    },
  };
}

/**
 * Converts an amount the contract compares against msg.value into the `value` to send over JSON-RPC.
 * On Hedera that is tinybars to weibars; every other chain passes the value through.
 */
export function toRpcValue(contractValue: bigint, chainId: number): bigint {
  return HEDERA_CHAIN_IDS.includes(chainId) ? contractValue * WEIBAR_PER_TINYBAR : contractValue;
}

/**
 * The worst entry price to accept, given the oracle price and a tolerance. Longs get a ceiling above the
 * price and shorts a floor below it. The tolerance must cover the engine's own spread.
 */
export function acceptablePrice(price: bigint, isLong: boolean, toleranceBps: bigint): bigint {
  return (price * (isLong ? BPS + toleranceBps : BPS - toleranceBps)) / BPS;
}

/** What an open will cost and reserve, mirroring `PerpEngine._fundPosition`. */
export function quoteOpen(collateral: bigint, leverage: bigint, config: EngineConfig) {
  const fee = (collateral * leverage * config.openFeeBps) / BPS;
  const margin = collateral > fee ? collateral - fee : 0n;
  return { fee, margin, size: margin * leverage, maxProfit: margin * config.maxProfitMultiple };
}

/**
 * Oracle price at which a position becomes liquidatable, mirroring `PerpEngine._payoutAt`:
 * equity falls to `liquidationThresholdBps` of margin, after the exit spread.
 */
export function liquidationPrice(
  position: Pick<Position, "isLong" | "margin" | "size" | "entryPrice">,
  config: EngineConfig,
) {
  if (position.size === 0n) return 0n;
  const lossAllowed = (position.margin * (BPS - config.liquidationThresholdBps)) / BPS;
  const move = (position.entryPrice * lossAllowed) / position.size;
  const exitPrice = position.isLong ? position.entryPrice - move : position.entryPrice + move;
  // Undo the exit spread to get back to the oracle price.
  return (exitPrice * BPS) / (position.isLong ? BPS - config.spreadBps : BPS + config.spreadBps);
}

export const parseCollateral = (amount: string) => parseUnits(amount, COLLATERAL_DECIMALS);

export function formatCollateral(amount: bigint, fractionDigits = 2): string {
  return Number(formatUnits(amount, COLLATERAL_DECIMALS)).toLocaleString("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

/** Prices span five orders of magnitude between HBAR and BTC, so pick the precision from the size. */
export function formatPrice(price: bigint): string {
  const value = Number(formatUnits(price, PRICE_DECIMALS));
  const fractionDigits = value >= 1000 ? 2 : value >= 1 ? 4 : 5;
  return value.toLocaleString("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

/** HIP-719: every HTS token exposes association at its own address. */
export const hip719Abi = [
  {
    type: "function",
    name: "associate",
    stateMutability: "nonpayable",
    inputs: [],
    outputs: [{ name: "responseCode", type: "uint256" }],
  },
] as const;
