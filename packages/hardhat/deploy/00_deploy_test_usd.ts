import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { DeployFunction } from "hardhat-deploy/types";

import { getDeployGasPrice } from "../utils/getDeployGasPrice";
import type { TestUSD } from "../typechain-types";
import { TEST_USD, getNetworkConfig } from "../utils/tinyperpConfig";

/**
 * Deploys TestUSD and has it create the HTS collateral token. TestUSD is the token's treasury and holds its
 * supply key, so the faucet can mint without any off-chain signer.
 */
const deployTestUsd: DeployFunction = async function (hre: HardhatRuntimeEnvironment) {
  const { deployer } = await hre.getNamedAccounts();
  const network = getNetworkConfig(hre.network.name);
  const gasPrice = await getDeployGasPrice(hre);

  await hre.deployments.deploy("TestUSD", {
    from: deployer,
    args: [deployer, TEST_USD.dripAmount, TEST_USD.dripCooldown],
    log: true,
    autoMine: true,
    gasLimit: "3000000",
    gasPrice,
  });

  const testUsd = await hre.ethers.getContract<TestUSD>("TestUSD", deployer);
  if ((await testUsd.token()) === hre.ethers.ZeroAddress) {
    const tx = await testUsd.createToken(TEST_USD.name, TEST_USD.symbol, {
      value: network.tokenCreationValue,
      gasLimit: 1_500_000,
      gasPrice,
    });
    await tx.wait();
    console.log(`Created HTS token ${TEST_USD.symbol} (tx ${tx.hash})`);
  }
  console.log(`${TEST_USD.symbol} token address: ${await testUsd.token()}`);
};

deployTestUsd.tags = ["TestUSD"];
export default deployTestUsd;
