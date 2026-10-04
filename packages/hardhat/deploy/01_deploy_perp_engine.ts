import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction } from "hardhat-deploy/types";

import { getDeployGasPrice } from "../utils/getDeployGasPrice";
import type { TestUSD } from "../typechain-types";
import { ENGINE_CONFIG, getNetworkConfig } from "../utils/tinyperpConfig";

/**
 * Deploys the engine against the collateral token and the network's oracles. Local networks have no
 * Chainlink or Supra, so they get mocks whose prices you can set by hand.
 */
const deployPerpEngine: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const { deploy } = hre.deployments;
  const network = getNetworkConfig(hre.network.name);
  const gasPrice = await getDeployGasPrice(hre);

  const testUsd = await hre.ethers.getContract<TestUSD>("TestUSD", deployer);
  const collateral = await testUsd.token();

  let supra = network.supra;
  if (!supra) {
    const mock = await deploy("MockSupraFeed", { from: deployer, log: true, autoMine: true, gasPrice });
    supra = mock.address;
  }

  await deploy("PerpEngine", {
    from: deployer,
    args: [
      deployer,
      collateral,
      { ...ENGINE_CONFIG, autoSettleFee: network.autoSettleFee },
      { supra, supraMaxAge: network.supraMaxAge, maxDeviationBps: network.maxDeviationBps },
    ],
    log: true,
    autoMine: true,
    gasLimit: "6000000",
    gasPrice,
  });
};

deployPerpEngine.tags = ["PerpEngine"];
deployPerpEngine.dependencies = ["TestUSD"];
export default deployPerpEngine;
