import * as chains from "viem/chains";

export type ScaffoldConfig = {
  targetNetworks: readonly [chains.Chain, ...chains.Chain[]];
  pollingInterval: number;
  rpcOverrides?: Record<number, string>;
  enableBurnerWallet: boolean;
  walletConnectProjectId: string;
};

// Multicall3 is deployed at its usual address on Hedera mainnet and testnet, but viem's chain definitions do
// not list it. Declaring it lets wagmi batch contract reads into one request.
const contracts = { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } } as const;
const hederaTestnet = { ...chains.hederaTestnet, contracts } as const satisfies chains.Chain;
const hederaMainnet = { ...chains.hedera, contracts } as const satisfies chains.Chain;

const hederaLocalFork = {
  ...chains.hardhat,
  contracts, // the local chain forks testnet, so the same deployment is there
  name: "Hedera Local Fork",
  nativeCurrency: {
    name: "HBAR",
    symbol: "HBAR",
    // Note: HBAR has 8 protocol decimals (tinybar),
    // but JSON-RPC msg.value & gasPrice use 18 decimals for EVM compatibility.
    // We keep 18 here so tx.value formatting matches what viem/hardhat return.
    decimals: 18,
  },
} as const satisfies chains.Chain;

// The local fork is only offered while developing, so a deployed app lists real networks only.
const targetNetworks: readonly [typeof hederaTestnet, typeof hederaMainnet, ...chains.Chain[]] =
  process.env.NODE_ENV === "development"
    ? [hederaTestnet, hederaMainnet, hederaLocalFork]
    : [hederaTestnet, hederaMainnet];

const scaffoldConfig = {
  targetNetworks,

  pollingInterval: 10000,

  // Off, so the app starts at "Connect wallet" instead of connecting a throwaway account with no funds.
  enableBurnerWallet: false,

  rpcOverrides: {
    [chains.hedera.id]: process.env.NEXT_PUBLIC_HEDERA_MAINNET_RPC_URL || "https://mainnet.hashio.io/api",
    [chains.hederaTestnet.id]: process.env.NEXT_PUBLIC_HEDERA_TESTNET_RPC_URL || "https://testnet.hashio.io/api",
  },

  walletConnectProjectId: process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID || "3a8170812b534d0ff9d794f19a901d64",
} as const satisfies ScaffoldConfig;

export default scaffoldConfig;
