import { ethers } from "ethers";

/**
 * Everything a deployment needs to know about a network: where the oracles live, which markets to list and
 * how the engine is tuned. Edit this file to retarget the template; the deploy scripts only read it.
 */

export type MarketConfig = {
  symbol: string;
  /** Chainlink Data Feed proxy. Leave out on local networks to get a MockAggregator instead. */
  feed?: string;
  /** Starting price of the mock feed on local networks, in USD. */
  mockPrice: string;
  /** Oldest Chainlink round, in seconds, the market trades on. Use the feed's heartbeat plus a margin. */
  maxPriceAge: number;
  maxLeverage: number;
  /** Supra pair index to cross-check against. Leave out to trade on Chainlink alone. */
  supraPairIndex?: number;
};

export type NetworkConfig = {
  /** Supra push oracle. Leave out on local networks to get a MockSupraFeed instead. */
  supra?: string;
  supraMaxAge: number;
  maxDeviationBps: number;
  markets: MarketConfig[];
  /** HBAR sent with TestUSD.createToken to pay the HTS creation fee, in the unit the RPC expects. */
  tokenCreationValue: bigint;
  /** Native amount that prepays one scheduled settlement, in the unit the contract sees as msg.value. */
  autoSettleFee: bigint;
};

const HOUR = 3600;
const DAY = 24 * HOUR;

/** Tinybars per HBAR. Inside the Hedera EVM, msg.value and address.balance are in tinybars. */
export const TINYBAR = 100_000_000n;
/** JSON-RPC values are in weibars (18 decimals). The relay divides by this to get tinybars. */
export const WEIBAR_PER_TINYBAR = 10_000_000_000n;

export const HEDERA_CHAIN_IDS = [295, 296];

/** Engine parameters shared by every network. See PerpEngine.Config for what each one does. */
export const ENGINE_CONFIG = {
  openFeeBps: 10,
  spreadBps: 10,
  liquidationThresholdBps: 1000,
  liquidatorRewardBps: 500,
  maxProfitMultiple: 4,
  minDuration: 2 * 60,
  maxDuration: 7 * DAY,
  autoSettleGasLimit: 500_000,
  minCollateral: ethers.parseUnits("1", 6),
};

export const TEST_USD = {
  name: "Tinyperp Test USD",
  symbol: "tUSD",
  dripAmount: ethers.parseUnits("10000", 6),
  dripCooldown: DAY,
  poolSeed: ethers.parseUnits("250000", 6),
};

const LOCAL: NetworkConfig = {
  supraMaxAge: HOUR,
  maxDeviationBps: 300,
  markets: [
    { symbol: "HBAR/USD", mockPrice: "0.10", maxPriceAge: 30 * DAY, maxLeverage: 10, supraPairIndex: 75 },
    { symbol: "BTC/USD", mockPrice: "80000", maxPriceAge: 30 * DAY, maxLeverage: 10 },
    { symbol: "ETH/USD", mockPrice: "2500", maxPriceAge: 30 * DAY, maxLeverage: 10 },
  ],
  // The local fork emulates HTS and reads msg.value as tinybars: 1 HBAR.
  tokenCreationValue: TINYBAR,
  // Nothing executes schedules on a local chain, so settlement there is always manual.
  autoSettleFee: 0n,
};

const HEDERA_TESTNET: NetworkConfig = {
  supra: "0x6Cd59830AAD978446e6cc7f6cc173aF7656Fb917",
  supraMaxAge: 6 * HOUR,
  maxDeviationBps: 500,
  // Testnet feeds update on a 24 hour heartbeat, far slower than mainnet. On mainnet set maxPriceAge to each
  // feed's published heartbeat and tighten maxDeviationBps.
  markets: [
    {
      symbol: "HBAR/USD",
      feed: "0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a",
      mockPrice: "0.10",
      maxPriceAge: 25 * HOUR,
      maxLeverage: 10,
      supraPairIndex: 75,
    },
    {
      symbol: "BTC/USD",
      feed: "0x058fE79CB5775d4b167920Ca6036B824805A9ABd",
      mockPrice: "80000",
      maxPriceAge: 25 * HOUR,
      maxLeverage: 10,
    },
    {
      symbol: "ETH/USD",
      feed: "0xb9d461e0b962aF219866aDfA7DD19C52bB9871b9",
      mockPrice: "2500",
      maxPriceAge: 25 * HOUR,
      maxLeverage: 10,
    },
  ],
  tokenCreationValue: ethers.parseEther("20"),
  // 500,000 gas at the testnet gas price of 87 tinybars is 0.435 HBAR. Round up.
  autoSettleFee: TINYBAR / 2n,
};

const NETWORKS: Record<string, NetworkConfig> = {
  hardhat: LOCAL,
  localhost: LOCAL,
  hederaTestnet: HEDERA_TESTNET,
};

export function isLocalNetwork(networkName: string): boolean {
  return networkName === "hardhat" || networkName === "localhost";
}

export function getNetworkConfig(networkName: string): NetworkConfig {
  const config = NETWORKS[networkName];
  if (!config) {
    throw new Error(
      `No Tinyperp config for network "${networkName}". Add one to packages/hardhat/utils/tinyperpConfig.ts. ` +
        `For mainnet, point the engine at a real HTS stablecoin instead of TestUSD.`,
    );
  }
  return config;
}

/**
 * Converts an amount the contract sees as msg.value into the `value` to send over JSON-RPC.
 * Hedera's relay takes weibars and hands the contract tinybars; every other chain passes the value through.
 */
export function toRpcValue(contractValue: bigint, chainId: number | bigint): bigint {
  return HEDERA_CHAIN_IDS.includes(Number(chainId)) ? contractValue * WEIBAR_PER_TINYBAR : contractValue;
}
