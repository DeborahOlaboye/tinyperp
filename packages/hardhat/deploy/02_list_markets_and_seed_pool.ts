import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction } from "hardhat-deploy/types";

import { getDeployGasPrice } from "../utils/getDeployGasPrice";
import type { MockSupraFeed, PerpEngine, TestUSD } from "../typechain-types";
import { TEST_USD, getNetworkConfig, isLocalNetwork } from "../utils/tinyperpConfig";

/**
 * Lists the network's markets and seeds the pool so the engine is usable straight after deploy.
 * Safe to run again: it skips markets that are already listed and a pool that already has liquidity.
 */
const listMarketsAndSeedPool: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const network = getNetworkConfig(hre.network.name);
  const gasPrice = await getDeployGasPrice(hre);
  const overrides = { gasLimit: 1_500_000, gasPrice };

  const engine = await hre.ethers.getContract<PerpEngine>("PerpEngine", deployer);
  const testUsd = await hre.ethers.getContract<TestUSD>("TestUSD", deployer);
  const token = await hre.ethers.getContractAt(
    "MockCollateral",
    await testUsd.token(),
    await hre.ethers.getSigner(deployer),
  );

  const listed = Number(await engine.marketCount());
  for (const [index, market] of network.markets.entries()) {
    if (index < listed) continue;

    let feed = market.feed;
    if (!feed) {
      const mock = await hre.deployments.deploy(`MockAggregator_${market.symbol.replace("/", "_")}`, {
        contract: "MockAggregator",
        from: deployer,
        args: [8, market.symbol.replace("/", " / "), hre.ethers.parseUnits(market.mockPrice, 8)],
        log: true,
        autoMine: true,
        gasPrice,
      });
      feed = mock.address;
    }
    if (!network.supra && market.supraPairIndex !== undefined) {
      const supra = await hre.ethers.getContract<MockSupraFeed>("MockSupraFeed", deployer);
      await (await supra.setValue(market.supraPairIndex, hre.ethers.parseUnits(market.mockPrice, 18))).wait();
    }

    const tx = await engine.listMarket(
      market.symbol,
      feed,
      market.maxPriceAge,
      market.maxLeverage,
      market.supraPairIndex !== undefined,
      market.supraPairIndex ?? 0,
      overrides,
    );
    await tx.wait();
    console.log(`Listed ${market.symbol} as market ${index} (feed ${feed})`);
  }

  if ((await engine.totalShares()) === 0n) {
    // On Hedera an account must be associated with an HTS token before it can hold it. The local fork does
    // not enforce this, and an account that is already associated makes the call fail, so both are fine.
    if (!isLocalNetwork(hre.network.name)) {
      try {
        await (await token.associate(overrides)).wait();
        console.log(`Associated the deployer with ${TEST_USD.symbol}`);
      } catch {
        console.log(`Deployer is already associated with ${TEST_USD.symbol}`);
      }
    }

    await (await testUsd.mintTo(deployer, TEST_USD.poolSeed, overrides)).wait();
    await (await token.approve(await engine.getAddress(), TEST_USD.poolSeed, overrides)).wait();
    await (await engine.deposit(TEST_USD.poolSeed, overrides)).wait();
    console.log(`Seeded the pool with ${hre.ethers.formatUnits(TEST_USD.poolSeed, 6)} ${TEST_USD.symbol}`);
  }
};

listMarketsAndSeedPool.tags = ["Markets"];
listMarketsAndSeedPool.dependencies = ["PerpEngine"];
export default listMarketsAndSeedPool;
