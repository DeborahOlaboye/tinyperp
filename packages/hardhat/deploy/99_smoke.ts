import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction } from "hardhat-deploy/types";

import { getDeployGasPrice } from "../utils/getDeployGasPrice";
import type { MockCollateral, PerpEngine, TestUSD } from "../typechain-types";
import { HEDERA_CHAIN_IDS, toRpcValue } from "../utils/tinyperpConfig";

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * End-to-end check against a deployed engine: takes tUSD from the faucet, opens and closes a position, then
 * opens one that the Hedera Schedule Service settles on its own. Prints a HashScan link for every step.
 *
 * Runs only through `yarn hardhat:smoke --network hederaTestnet`, never as part of a normal deploy.
 */
const smoke: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { chainId } = await hre.ethers.provider.getNetwork();
  const overrides = { gasLimit: 1_500_000, gasPrice: await getDeployGasPrice(hre) };

  const engine = await hre.ethers.getContract<PerpEngine>("PerpEngine", deployer);
  const testUsd = await hre.ethers.getContract<TestUSD>("TestUSD", deployer);
  const signer = await hre.ethers.getSigner(deployer);
  const token = (await hre.ethers.getContractAt("MockCollateral", await testUsd.token(), signer)) as MockCollateral;
  const config = await engine.config();

  const link = (hash: string) =>
    HEDERA_CHAIN_IDS.includes(Number(chainId))
      ? `https://hashscan.io/${chainId === 295n ? "mainnet" : "testnet"}/transaction/${hash}`
      : hash;
  const step = async (label: string, tx: Promise<{ hash: string; wait: () => Promise<unknown> }>) => {
    const sent = await tx;
    await sent.wait();
    console.log(`${label}\n  ${link(sent.hash)}`);
  };

  const collateralAmount = hre.ethers.parseUnits("100", 6);
  const latestBlock = await hre.ethers.provider.getBlock("latest");
  if ((await testUsd.nextDripAt(deployer)) <= BigInt(latestBlock!.timestamp)) {
    await step("Faucet: mint tUSD through the HTS system contract", testUsd.drip(overrides));
  }
  await step(
    "Approve the engine to pull tUSD",
    token.approve(await engine.getAddress(), collateralAmount * 2n, overrides),
  );

  const price = await engine.markPrice(0);
  console.log(`HBAR/USD from Chainlink, cross-checked against Supra: ${hre.ethers.formatUnits(price, 18)}`);

  const closedId = await engine.nextPositionId();
  await step(
    `Open position ${closedId}: long HBAR/USD, 100 tUSD at 5x`,
    engine.openPosition(0, true, collateralAmount, 5, config.maxDuration, hre.ethers.MaxUint256, false, overrides),
  );
  await step(`Close position ${closedId}`, engine.closePosition(closedId, overrides));

  const scheduledId = await engine.nextPositionId();
  await step(
    `Open position ${scheduledId}: short HBAR/USD, 100 tUSD at 3x, settled by the Schedule Service`,
    engine.openPosition(0, false, collateralAmount, 3, config.minDuration, 0, true, {
      ...overrides,
      value: toRpcValue(config.autoSettleFee, chainId),
    }),
  );
  const { schedule, expiresAt } = await engine.getPosition(scheduledId);
  if (schedule === hre.ethers.ZeroAddress) {
    console.log("No schedule was booked (this network has no Schedule Service). Settle the position by hand.");
    return;
  }
  console.log(
    `Schedule ${schedule} will call settleExpired(${scheduledId}) at ${new Date(Number(expiresAt) * 1000).toISOString()}`,
  );

  const deadline = Number(expiresAt) * 1000 + 90_000;
  while (Date.now() < deadline) {
    await sleep(10_000);
    const stillOpen = await engine.getPosition(scheduledId).then(
      () => true,
      () => false,
    );
    if (!stillOpen) {
      const [settled] = await engine.queryFilter(engine.filters.PositionSettled(scheduledId), latestBlock!.number);
      console.log(`Position ${scheduledId} was settled by the network, with no keeper`);
      if (settled) console.log(`  ${link(settled.transactionHash)}`);
      return;
    }
  }
  console.log(`Position ${scheduledId} is still open after its term. Settle it by hand with settleExpired.`);
};

smoke.tags = ["Smoke"];
smoke.skip = async () => process.env.TINYPERP_SMOKE !== "true";
export default smoke;
