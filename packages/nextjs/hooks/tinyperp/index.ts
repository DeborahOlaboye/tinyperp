import { useCallback, useMemo } from "react";
import { Abi, Address, erc20Abi, zeroAddress } from "viem";
import { useReadContract, useReadContracts, useWriteContract } from "wagmi";
import { useDeployedContractInfo, useSelectedNetwork, useTransactor } from "~~/hooks/scaffold-hbar";
import scaffoldConfig from "~~/scaffold.config";
import {
  AUTO_SETTLE_OPEN_GAS,
  EngineConfig,
  Market,
  PoolState,
  Position,
  acceptablePrice,
  hip719Abi,
  toEngineConfig,
  toMarket,
  toPosition,
  toRpcValue,
} from "~~/utils/tinyperp";

/**
 * Everything the UI needs from PerpEngine, as React hooks. Reads refresh on the scaffold's polling
 * interval; writes go through the scaffold's transactor, so they show the usual toasts and explorer links.
 */

const polling = { refetchInterval: scaffoldConfig.pollingInterval } as const;

type ContractHandle = { address: Address; abi: Abi; chainId: number };

function useContract(contractName: "PerpEngine" | "TestUSD"): ContractHandle | undefined {
  const { data } = useDeployedContractInfo({ contractName });
  const { id: chainId } = useSelectedNetwork();
  return useMemo(
    () => (data ? { address: data.address as Address, abi: data.abi as Abi, chainId } : undefined),
    [data, chainId],
  );
}

/** The engine's fixed parameters: fees, spread, limits and the scheduled-settlement fee. */
export function useEngineConfig() {
  const engine = useContract("PerpEngine");
  const { data, isLoading } = useReadContract({ ...engine, functionName: "config", query: { enabled: !!engine } });
  const config = useMemo(() => (data ? toEngineConfig(data as readonly bigint[]) : undefined), [data]);
  return { config, isLoading };
}

/** Every listed market with its current oracle price. A halted or stale market has no price. */
export function useMarkets() {
  const engine = useContract("PerpEngine");
  const { data: count } = useReadContract({
    ...engine,
    functionName: "marketCount",
    query: { enabled: !!engine },
  });
  const ids = useMemo(() => Array.from({ length: Number(count ?? 0) }, (_, index) => BigInt(index)), [count]);

  const { data, isLoading, refetch } = useReadContracts({
    contracts: engine
      ? ids.flatMap(id => [
          { ...engine, functionName: "getMarket", args: [id] },
          { ...engine, functionName: "markPrice", args: [id] },
        ])
      : [],
    query: { enabled: !!engine && ids.length > 0, ...polling },
  });

  const markets = useMemo(
    () =>
      ids.flatMap((id, index): Market[] => {
        const market = data?.[2 * index];
        const price = data?.[2 * index + 1];
        if (market?.status !== "success") return [];
        return [
          toMarket(
            id,
            market.result as Parameters<typeof toMarket>[1],
            price?.status === "success" ? (price.result as bigint) : undefined,
          ),
        ];
      }),
    [ids, data],
  );
  return { markets, isLoading, refetch };
}

/** An account's open positions, each with what settling it now would pay. */
export function usePositions(account?: Address) {
  const engine = useContract("PerpEngine");
  const { data: idList, refetch: refetchIds } = useReadContract({
    ...engine,
    functionName: "openPositionIdsOf",
    args: [account ?? zeroAddress],
    query: { enabled: !!engine && !!account, ...polling },
  });
  const ids = useMemo(() => (idList as readonly bigint[] | undefined) ?? [], [idList]);

  const {
    data,
    isLoading,
    refetch: refetchDetails,
  } = useReadContracts({
    contracts: engine
      ? ids.flatMap(id => [
          { ...engine, functionName: "getPosition", args: [id] },
          { ...engine, functionName: "positionStatus", args: [id] },
        ])
      : [],
    query: { enabled: !!engine && ids.length > 0, ...polling },
  });

  const positions = useMemo(
    () =>
      ids.flatMap((id, index): Position[] => {
        const position = data?.[2 * index];
        const status = data?.[2 * index + 1];
        if (position?.status !== "success") return [];
        return [
          toPosition(
            id,
            position.result as Parameters<typeof toPosition>[1],
            status?.status === "success" ? (status.result as Parameters<typeof toPosition>[2]) : undefined,
          ),
        ];
      }),
    [ids, data],
  );

  const refetch = useCallback(async () => {
    await refetchIds();
    await refetchDetails();
  }, [refetchIds, refetchDetails]);
  return { positions, isLoading, refetch };
}

/** Pool size, how much of it open positions have reserved, and the account's share of it. */
export function usePool(account?: Address) {
  const engine = useContract("PerpEngine");
  const { data, isLoading, refetch } = useReadContracts({
    contracts: engine
      ? [
          { ...engine, functionName: "poolAssets" },
          { ...engine, functionName: "reservedAssets" },
          { ...engine, functionName: "totalShares" },
          { ...engine, functionName: "sharesOf", args: [account ?? zeroAddress] },
        ]
      : [],
    query: { enabled: !!engine, ...polling },
  });

  const pool = useMemo((): PoolState | undefined => {
    if (!data || data.some(entry => entry.status !== "success")) return undefined;
    const [poolAssets, reservedAssets, totalShares, shares] = data.map(entry => entry.result as bigint);
    return {
      poolAssets,
      reservedAssets,
      freeLiquidity: poolAssets - reservedAssets,
      totalShares,
      shares,
      shareValue: totalShares === 0n ? 0n : (shares * poolAssets) / totalShares,
    };
  }, [data]);
  return { pool, isLoading, refetch };
}

/** The collateral token: the account's balance, and how much of it the engine may pull. */
export function useCollateral(account?: Address) {
  const engine = useContract("PerpEngine");
  const { data: token } = useReadContract({
    ...engine,
    functionName: "collateral",
    query: { enabled: !!engine },
  });
  const address = token as Address | undefined;

  const { data, isLoading, refetch } = useReadContracts({
    contracts:
      engine && address && account
        ? [
            { address, abi: erc20Abi, chainId: engine.chainId, functionName: "balanceOf", args: [account] },
            {
              address,
              abi: erc20Abi,
              chainId: engine.chainId,
              functionName: "allowance",
              args: [account, engine.address],
            },
          ]
        : [],
    query: { enabled: !!engine && !!address && !!account, ...polling },
  });

  return {
    address,
    balance: data?.[0]?.status === "success" ? (data[0].result as bigint) : undefined,
    allowance: data?.[1]?.status === "success" ? (data[1].result as bigint) : undefined,
    isLoading,
    refetch,
  };
}

export type OpenPositionRequest = {
  market: Market;
  isLong: boolean;
  /** Collateral to pull from the trader, in the token's smallest unit. */
  collateral: bigint;
  leverage: bigint;
  /** Term in seconds. */
  duration: bigint;
  /** Let the Hedera Schedule Service settle the position at expiry. Costs `config.autoSettleFee` in HBAR. */
  autoSettle: boolean;
  /** How far the entry price may move against the trader before the open reverts. Must exceed the spread. */
  toleranceBps?: bigint;
};

/** Every transaction the UI can send. Each resolves to the transaction hash once it is confirmed. */
export function useTinyperpActions(config?: EngineConfig) {
  const engine = useContract("PerpEngine");
  const faucet = useContract("TestUSD");
  const { writeContractAsync, isPending } = useWriteContract();
  const transact = useTransactor();

  const send = useCallback(
    (request: Parameters<typeof writeContractAsync>[0]) => transact(() => writeContractAsync(request)),
    [transact, writeContractAsync],
  );
  const callEngine = useCallback(
    (functionName: string, args: readonly unknown[], overrides: { value?: bigint; gas?: bigint } = {}) => {
      if (!engine) throw new Error("PerpEngine is not deployed on this network");
      // With a generic ABI wagmi cannot tell which functions are payable, so the request is cast.
      return send({ ...engine, functionName, args, ...overrides } as Parameters<typeof send>[0]);
    },
    [engine, send],
  );

  return {
    isPending,

    /** Faucet: mints test collateral to the caller, once per cooldown. */
    drip: useCallback(() => {
      if (!faucet) throw new Error("TestUSD is not deployed on this network");
      return send({ ...faucet, functionName: "drip", args: [] });
    }, [faucet, send]),

    /** Associates the caller with the collateral token. Needed on Hedera before an account can hold it. */
    associate: useCallback(
      (token: Address) => {
        if (!engine) throw new Error("PerpEngine is not deployed on this network");
        return send({ address: token, abi: hip719Abi, chainId: engine.chainId, functionName: "associate", args: [] });
      },
      [engine, send],
    ),

    /** Lets the engine pull `amount` of collateral from the caller. */
    approve: useCallback(
      (token: Address, amount: bigint) => {
        if (!engine) throw new Error("PerpEngine is not deployed on this network");
        return send({
          address: token,
          abi: erc20Abi,
          chainId: engine.chainId,
          functionName: "approve",
          args: [engine.address, amount],
        });
      },
      [engine, send],
    ),

    openPosition: useCallback(
      ({ market, isLong, collateral, leverage, duration, autoSettle, toleranceBps = 50n }: OpenPositionRequest) => {
        if (!engine) throw new Error("PerpEngine is not deployed on this network");
        if (market.price === undefined) throw new Error(`${market.symbol} has no price right now`);
        if (autoSettle && !config) throw new Error("Engine config has not loaded yet");

        const limit = acceptablePrice(market.price, isLong, toleranceBps);
        return callEngine(
          "openPosition",
          [market.id, isLong, collateral, leverage, duration, limit, autoSettle],
          autoSettle
            ? { value: toRpcValue(config!.autoSettleFee, engine.chainId), gas: AUTO_SETTLE_OPEN_GAS }
            : undefined,
        );
      },
      [engine, config, callEngine],
    ),

    closePosition: useCallback((positionId: bigint) => callEngine("closePosition", [positionId]), [callEngine]),
    liquidate: useCallback((positionId: bigint) => callEngine("liquidate", [positionId]), [callEngine]),
    settleExpired: useCallback((positionId: bigint) => callEngine("settleExpired", [positionId]), [callEngine]),
    deposit: useCallback((assets: bigint) => callEngine("deposit", [assets]), [callEngine]),
    withdraw: useCallback((shares: bigint) => callEngine("withdraw", [shares]), [callEngine]),
    claim: useCallback(() => callEngine("claim", []), [callEngine]),
  };
}
