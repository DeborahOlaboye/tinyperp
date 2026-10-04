import { useCallback, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Abi, Address, BaseError, ContractFunctionRevertedError, Hash, erc20Abi, zeroAddress } from "viem";
import { useAccount, useBalance, usePublicClient, useReadContracts, useWriteContract } from "wagmi";
import { useDeployedContractInfo, useSelectedNetwork } from "~~/hooks/scaffold-hbar";
import scaffoldConfig from "~~/scaffold.config";
import {
  APPROVAL_AMOUNT,
  EngineConfig,
  GAS,
  Market,
  OracleGuard,
  Position,
  RawMarket,
  RawPosition,
  acceptablePrice,
  aggregatorAbi,
  hip719Abi,
  scalePrice,
  supraAbi,
  toEngineConfig,
  toEntityId,
  toMarket,
  toOracleGuard,
  toPosition,
  toRpcValue,
} from "~~/utils/tinyperp";

/**
 * Everything the UI needs from the chain, as two hooks: `useTinyperp` reads and `useTinyperpActions` writes.
 * Reads are batched through Multicall3, so each group below is one RPC request per polling interval.
 */

/** How many of the most recent position ids the liquidation board looks at. */
const BOARD_SCAN = 60;

const MIRROR_NODES: Record<number, string> = {
  295: "https://mainnet.mirrornode.hedera.com",
  296: "https://testnet.mirrornode.hedera.com",
};

const polling = { refetchInterval: scaffoldConfig.pollingInterval } as const;

type ContractHandle = { address: Address; abi: Abi; chainId: number };
type Call = ContractHandle & { functionName: string; args?: readonly unknown[] };
type Result = { status: "success" | "failure"; result?: unknown } | undefined;

const ok = <T>(entry: Result) => (entry?.status === "success" ? (entry.result as T) : undefined);

function useContract(contractName: "PerpEngine" | "TestUSD"): ContractHandle | undefined {
  const { data } = useDeployedContractInfo({ contractName });
  const { id: chainId } = useSelectedNetwork();
  return useMemo(
    () => (data ? { address: data.address as Address, abi: data.abi as Abi, chainId } : undefined),
    [data, chainId],
  );
}

function useCalls(calls: Call[], enabled = true) {
  return useReadContracts({ contracts: calls, query: { enabled: enabled && calls.length > 0, ...polling } });
}

/** The current time in seconds, ticking once a second, for countdowns and price ages. */
export function useNow() {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

export type Association = "associated" | "automatic" | "none" | "unknown";

/**
 * Whether an account can hold an HTS token. Only the mirror node knows: an account is either associated
 * already, or has automatic association slots that associate it on first receipt.
 */
function useAssociation(chainId: number, account?: Address, token?: Address) {
  const mirror = MIRROR_NODES[chainId];
  return useQuery({
    queryKey: ["tinyperp-association", chainId, account, token],
    enabled: !!account && !!token,
    refetchInterval: scaffoldConfig.pollingInterval,
    queryFn: async (): Promise<Association> => {
      if (!mirror) return "associated"; // a local fork does not enforce association
      const base = `${mirror}/api/v1/accounts/${account}`;
      const relationship = await fetch(`${base}/tokens?token.id=${toEntityId(token!)}`);
      if (relationship.status === 404) return "automatic"; // not on the ledger yet: created with open slots
      if (!relationship.ok) return "unknown";
      if (((await relationship.json()) as { tokens?: unknown[] }).tokens?.length) return "associated";

      const info = await fetch(base);
      if (!info.ok) return "unknown";
      const slots = ((await info.json()) as { max_automatic_token_associations?: number })
        .max_automatic_token_associations;
      return slots === -1 || (slots ?? 0) > 0 ? "automatic" : "none";
    },
  });
}

export function useTinyperp() {
  const { address: account, chain: walletChain } = useAccount();
  const selectedNetwork = useSelectedNetwork();
  const chainId = selectedNetwork.id;
  const engine = useContract("PerpEngine");
  const faucet = useContract("TestUSD");
  const me = account ?? zeroAddress;

  // 1. The engine: parameters, pool totals and the connected account's stake.
  const core = useCalls(
    engine
      ? [
          { ...engine, functionName: "config" },
          { ...engine, functionName: "oracleGuard" },
          { ...engine, functionName: "owner" },
          { ...engine, functionName: "collateral" },
          { ...engine, functionName: "marketCount" },
          { ...engine, functionName: "nextPositionId" },
          { ...engine, functionName: "poolAssets" },
          { ...engine, functionName: "reservedAssets" },
          { ...engine, functionName: "totalShares" },
          { ...engine, functionName: "sharesOf", args: [me] },
          { ...engine, functionName: "claimable", args: [me] },
          { ...engine, functionName: "openPositionIdsOf", args: [me] },
        ]
      : [],
  );
  const config = useMemo((): EngineConfig | undefined => {
    const raw = ok<readonly bigint[]>(core.data?.[0]);
    return raw && toEngineConfig(raw);
  }, [core.data]);
  const guard = useMemo((): OracleGuard | undefined => {
    const raw = ok<readonly [Address, number, number]>(core.data?.[1]);
    return raw && toOracleGuard(raw);
  }, [core.data]);
  const owner = ok<Address>(core.data?.[2]);
  const token = ok<Address>(core.data?.[3]);
  const marketCount = Number(ok<bigint>(core.data?.[4]) ?? 0n);
  const nextPositionId = ok<bigint>(core.data?.[5]) ?? 1n;
  const poolAssets = ok<bigint>(core.data?.[6]);
  const reservedAssets = ok<bigint>(core.data?.[7]);
  const totalShares = ok<bigint>(core.data?.[8]);
  const shares = ok<bigint>(core.data?.[9]) ?? 0n;
  const claimable = ok<bigint>(core.data?.[10]) ?? 0n;
  const myIds = useMemo(() => ok<readonly bigint[]>(core.data?.[11]) ?? [], [core.data]);

  // 2. Market definitions.
  const marketCalls = useMemo(
    () =>
      engine
        ? Array.from({ length: marketCount }, (_, id) => ({
            ...engine,
            functionName: "getMarket",
            args: [BigInt(id)],
          }))
        : [],
    [engine, marketCount],
  );
  const marketData = useCalls(marketCalls);
  const listed = useMemo(
    () =>
      (marketData.data ?? []).flatMap((entry, id) => {
        const raw = ok<RawMarket>(entry);
        return raw ? [toMarket(BigInt(id), raw)] : [];
      }),
    [marketData.data],
  );

  // 3. Oracles, read directly so the UI can show a price the engine itself would refuse to trade on.
  const oracleCalls = useMemo(
    () =>
      listed.flatMap((market): Call[] => [
        { address: market.feed, abi: aggregatorAbi as Abi, chainId, functionName: "latestRoundData" },
        ...(market.crossCheck && guard && guard.supra !== zeroAddress
          ? [
              {
                address: guard.supra,
                abi: supraAbi as Abi,
                chainId,
                functionName: "getSvalue",
                args: [market.supraPairIndex],
              },
            ]
          : []),
      ]),
    [listed, guard, chainId],
  );
  const oracleData = useCalls(oracleCalls);

  type Round = readonly [bigint, bigint, bigint, bigint, bigint];
  type SupraValue = { decimals: bigint; time: bigint; price: bigint };
  const priced = useMemo(() => {
    let cursor = 0;
    return listed.map((market): Market & { roundId?: bigint } => {
      const round = ok<Round>(oracleData.data?.[cursor++]);
      const supra =
        market.crossCheck && guard && guard.supra !== zeroAddress
          ? ok<SupraValue>(oracleData.data?.[cursor++])
          : undefined;
      return {
        ...market,
        roundId: round?.[0],
        price: round && round[1] > 0n ? scalePrice(round[1], market.feedDecimals) : undefined,
        updatedAt: round?.[3],
        supraPrice: supra && supra.price > 0n ? scalePrice(supra.price, Number(supra.decimals)) : undefined,
        supraUpdatedAt: supra ? supra.time / 1000n : undefined, // Supra reports milliseconds
      };
    });
  }, [listed, guard, oracleData.data]);

  // 4. The round before each latest one, for the change shown beside the price.
  const previousCalls = useMemo(
    () =>
      priced.flatMap((market): Call[] =>
        market.roundId
          ? [
              {
                address: market.feed,
                abi: aggregatorAbi as Abi,
                chainId,
                functionName: "getRoundData",
                args: [market.roundId - 1n],
              },
            ]
          : [],
      ),
    [priced, chainId],
  );
  const previousData = useCalls(previousCalls);
  const markets = useMemo(() => {
    let cursor = 0;
    return priced.map(({ roundId, ...market }): Market => {
      const previous = roundId ? ok<Round>(previousData.data?.[cursor++]) : undefined;
      return {
        ...market,
        previousPrice: previous && previous[1] > 0n ? scalePrice(previous[1], market.feedDecimals) : undefined,
      };
    });
  }, [priced, previousData.data]);

  // 5. Positions: the connected account's own, and the most recent ids across all traders.
  const boardIds = useMemo(() => {
    const first = nextPositionId > BigInt(BOARD_SCAN) ? nextPositionId - BigInt(BOARD_SCAN) : 1n;
    return Array.from({ length: Number(nextPositionId - first) }, (_, index) => first + BigInt(index));
  }, [nextPositionId]);
  const positionIds = useMemo(() => [...new Set([...myIds, ...boardIds])], [myIds, boardIds]);
  const positionCalls = useMemo(
    () => (engine ? positionIds.map(id => ({ ...engine, functionName: "getPosition", args: [id] })) : []),
    [engine, positionIds],
  );
  const positionData = useCalls(positionCalls);
  // Settled positions revert with PositionNotFound and drop out here.
  const openPositions = useMemo(
    () =>
      positionIds.flatMap((id, index): Position[] => {
        const raw = ok<RawPosition>(positionData.data?.[index]);
        return raw ? [toPosition(id, raw)] : [];
      }),
    [positionIds, positionData.data],
  );
  const positions = useMemo(
    () => openPositions.filter(position => !!account && position.owner.toLowerCase() === account.toLowerCase()),
    [openPositions, account],
  );

  // 6. The collateral token and its faucet.
  const walletCalls = useMemo(
    (): Call[] => [
      ...(token && engine
        ? [
            { address: token, abi: erc20Abi as Abi, chainId, functionName: "balanceOf", args: [me] },
            { address: token, abi: erc20Abi as Abi, chainId, functionName: "allowance", args: [me, engine.address] },
          ]
        : []),
      ...(faucet
        ? [
            { ...faucet, functionName: "dripAmount" },
            { ...faucet, functionName: "dripCooldown" },
            { ...faucet, functionName: "nextDripAt", args: [me] },
          ]
        : []),
    ],
    [token, engine, faucet, chainId, me],
  );
  const walletData = useCalls(walletCalls);
  const tokenOffset = token && engine ? 2 : 0;
  // An account Hedera has never seen makes these reads revert. For a connected wallet that means zero.
  const unseen = !!account && !!walletData.data ? 0n : undefined;
  const collateralBalance = tokenOffset ? (ok<bigint>(walletData.data?.[0]) ?? unseen) : undefined;
  const allowance = tokenOffset ? (ok<bigint>(walletData.data?.[1]) ?? unseen) : undefined;
  const dripAmount = faucet ? ok<bigint>(walletData.data?.[tokenOffset]) : undefined;
  const dripCooldown = faucet ? ok<bigint>(walletData.data?.[tokenOffset + 1]) : undefined;
  const nextDripAt = faucet ? ok<bigint>(walletData.data?.[tokenOffset + 2]) : undefined;

  const native = useBalance({ address: account, chainId, query: { enabled: !!account, ...polling } });
  const budget = useBalance({ address: engine?.address, chainId, query: { enabled: !!engine, ...polling } });
  const association = useAssociation(chainId, account, token);

  const refetchers = [core, marketData, oracleData, previousData, positionData, walletData, native, budget];
  const refetchAssociation = association.refetch;
  const refetch = useCallback(async () => {
    await Promise.all([...refetchers.map(query => query.refetch()), refetchAssociation()]);
    // The query objects are stable per hook call; listing them all would only add noise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refetchAssociation, ...refetchers.map(query => query.refetch)]);

  return {
    chainId,
    network: selectedNetwork,
    account,
    wrongNetwork: !!account && walletChain?.id !== chainId,
    engine,
    faucet,
    token,
    isDeployed: !!engine,
    isLoading: core.isLoading,
    config,
    guard,
    owner,
    isOwner: !!account && !!owner && owner.toLowerCase() === account.toLowerCase(),
    markets,
    positions,
    openPositions,
    pool:
      poolAssets !== undefined && reservedAssets !== undefined && totalShares !== undefined
        ? {
            poolAssets,
            reservedAssets,
            freeLiquidity: poolAssets - reservedAssets,
            totalShares,
            shares,
            shareValue: totalShares === 0n ? 0n : (shares * poolAssets) / totalShares,
          }
        : undefined,
    claimable,
    wallet: {
      collateral: collateralBalance,
      allowance,
      /** HBAR in weibars, as JSON-RPC reports it. */
      native: native.data?.value,
      association: (association.data ?? "unknown") as Association,
    },
    drip: dripAmount !== undefined && dripCooldown !== undefined ? { dripAmount, dripCooldown, nextDripAt } : undefined,
    /** HBAR the engine holds to pay for scheduled settlements, in weibars. */
    budget: budget.data?.value,
    refetch,
  };
}

export type Tinyperp = ReturnType<typeof useTinyperp>;

/** Reverts worth explaining in plain words. Anything else shows the error's own name. */
const ERROR_TEXT: Record<string, string> = {
  InsufficientLiquidity: "The pool does not have enough free liquidity for that.",
  StaleOraclePrice: "The Chainlink price is too old to trade on. Try again after the next update.",
  OracleDeviationTooHigh: "Chainlink and Supra disagree, so this market is halted for now.",
  PriceNotAcceptable: "The price moved past your limit. Try again.",
  NotLiquidatable: "This position is healthy again and cannot be liquidated.",
  NotExpired: "This position has not reached its expiry yet.",
  MarketClosed: "This market is close-only.",
  CollateralTooSmall: "That is below the minimum collateral.",
  AutoSettleNeedsMoreGas: "The transaction needs a higher gas limit to book the scheduled settlement.",
  AutoSettleFeeTooLow: "Not enough HBAR was sent to prepay the scheduled settlement.",
  DripOnCooldown: "The faucet has already paid this account today.",
  HtsTransferFailed: "The token could not be delivered. Associate the account with tUSD first.",
  OwnableUnauthorizedAccount: "Only the engine owner can do that.",
};

export function explainError(error: unknown): string {
  if (error instanceof BaseError) {
    const reverted = error.walk(cause => cause instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      if (name) return ERROR_TEXT[name] ?? `The contract rejected this: ${name}.`;
    }
    if (/user rejected|denied transaction/i.test(error.message)) return "Cancelled in the wallet.";
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : "Something went wrong.";
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
  /** The entry price quoted to the user, 18 decimals. */
  entryPrice: bigint;
  /** How far the entry price may move against the trader before the open reverts. */
  toleranceBps?: bigint;
};

/** Every transaction the UI can send. Each resolves to the transaction hash once it has been mined. */
export function useTinyperpActions({ engine, faucet, token, config, wallet, account, refetch }: Tinyperp) {
  const { writeContractAsync } = useWriteContract();
  const publicClient = usePublicClient({ chainId: engine?.chainId });

  const send = useCallback(
    async (call: Call, overrides: { gas: bigint; value?: bigint; simulate?: boolean }): Promise<Hash> => {
      if (!publicClient) throw new Error("No connection to the network.");
      const { simulate, ...txOverrides } = overrides;
      const request = { ...call, ...txOverrides } as Parameters<typeof writeContractAsync>[0];

      // A dry run turns a revert into a readable reason before the wallet opens. Only reverts the engine
      // is known to raise stop the send: the relay cannot always reproduce calls that reach Hedera system
      // contracts, so any other simulation failure is ignored and the real transaction decides.
      if (simulate && account) {
        try {
          await publicClient.simulateContract({ ...request, account } as never);
        } catch (error) {
          const reverted = error instanceof BaseError && error.walk(e => e instanceof ContractFunctionRevertedError);
          const name = reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined;
          if (name && name in ERROR_TEXT) throw error;
        }
      }

      const hash = await writeContractAsync(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== "success") throw new Error("The transaction was mined but reverted.");
      await refetch();
      return hash;
    },
    [publicClient, writeContractAsync, refetch, account],
  );

  const callEngine = useCallback(
    (functionName: string, args: readonly unknown[], gas: bigint, value?: bigint) => {
      if (!engine) throw new Error("PerpEngine is not deployed on this network.");
      // An open that books a schedule calls the Schedule Service, which the relay cannot dry-run.
      return send({ ...engine, functionName, args }, { gas, value, simulate: gas !== GAS.openAutoSettle });
    },
    [engine, send],
  );

  const callToken = useCallback(
    (abi: Abi, functionName: string, args: readonly unknown[], gas: bigint) => {
      if (!engine || !token) throw new Error("The collateral token has not loaded yet.");
      return send({ address: token, abi, chainId: engine.chainId, functionName, args }, { gas });
    },
    [engine, token, send],
  );

  /** Asks for an allowance if the engine cannot pull `amount` yet. Resolves once it can. */
  const ensureAllowance = useCallback(
    async (amount: bigint) => {
      if ((wallet.allowance ?? 0n) >= amount) return;
      await callToken(erc20Abi as Abi, "approve", [engine!.address, APPROVAL_AMOUNT], GAS.approve);
    },
    [wallet.allowance, callToken, engine],
  );

  return {
    associate: useCallback(() => callToken(hip719Abi as Abi, "associate", [], GAS.associate), [callToken]),
    dissociate: useCallback(() => callToken(hip719Abi as Abi, "dissociate", [], GAS.associate), [callToken]),

    drip: useCallback(() => {
      if (!faucet) throw new Error("TestUSD is not deployed on this network.");
      return send({ ...faucet, functionName: "drip", args: [] }, { gas: GAS.drip });
    }, [faucet, send]),

    openPosition: useCallback(
      async (request: OpenPositionRequest) => {
        if (!engine || !config) throw new Error("The engine has not loaded yet.");
        await ensureAllowance(request.collateral);
        const limit = acceptablePrice(request.entryPrice, request.isLong, request.toleranceBps ?? 50n);
        return callEngine(
          "openPosition",
          [
            request.market.id,
            request.isLong,
            request.collateral,
            request.leverage,
            request.duration,
            limit,
            request.autoSettle,
          ],
          request.autoSettle ? GAS.openAutoSettle : GAS.open,
          request.autoSettle ? toRpcValue(config.autoSettleFee, engine.chainId) : undefined,
        );
      },
      [engine, config, ensureAllowance, callEngine],
    ),

    closePosition: useCallback((id: bigint) => callEngine("closePosition", [id], GAS.settle), [callEngine]),
    liquidate: useCallback((id: bigint) => callEngine("liquidate", [id], GAS.settle), [callEngine]),
    settleExpired: useCallback((id: bigint) => callEngine("settleExpired", [id], GAS.settle), [callEngine]),
    claim: useCallback(() => callEngine("claim", [], GAS.pool), [callEngine]),

    deposit: useCallback(
      async (assets: bigint) => {
        await ensureAllowance(assets);
        return callEngine("deposit", [assets], GAS.pool);
      },
      [ensureAllowance, callEngine],
    ),
    withdraw: useCallback((shares: bigint) => callEngine("withdraw", [shares], GAS.pool), [callEngine]),

    setMarketOpenEnabled: useCallback(
      (marketId: bigint, enabled: boolean) => callEngine("setMarketOpenEnabled", [marketId, enabled], GAS.admin),
      [callEngine],
    ),
    listMarket: useCallback(
      (symbol: string, feed: Address, maxPriceAge: number, maxLeverage: number, crossCheck: boolean, pair: bigint) =>
        callEngine("listMarket", [symbol, feed, maxPriceAge, maxLeverage, crossCheck, pair], GAS.admin),
      [callEngine],
    ),
    /** `amount` is in the unit the contract sees: tinybars on Hedera. */
    sweepNative: useCallback(
      (to: Address, amount: bigint) => callEngine("sweepNative", [to, amount], GAS.admin),
      [callEngine],
    ),
  };
}

export type TinyperpActions = ReturnType<typeof useTinyperpActions>;
