import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

// The Hardhat network forks Hedera testnet, so these tests read the real Chainlink and Supra contracts.
// They prove the engine's oracle reads against the live deployments rather than against mocks.

const CHAINLINK_HBAR_USD = "0x59bC155EB6c6C415fE43255aF66EcF0523c92B4a";
const SUPRA_PUSH_ORACLE = "0x6Cd59830AAD978446e6cc7f6cc173aF7656Fb917";
const SUPRA_HBAR_USDT_PAIR = 75;
const DAY = 24 * 3600;

const config = {
  openFeeBps: 10,
  spreadBps: 10,
  liquidationThresholdBps: 1000,
  liquidatorRewardBps: 500,
  maxProfitMultiple: 4,
  minDuration: 60,
  maxDuration: 7 * DAY,
  autoSettleGasLimit: 0,
  minCollateral: 1_000_000n,
  autoSettleFee: 0n,
};

describe("Live oracles on the Hedera testnet fork", function () {
  before(function () {
    // The addresses below are testnet deployments, so skip when the fork points anywhere else.
    const { forking } = network.config as { forking?: { enabled?: boolean; chainId?: number } };
    if (!forking?.enabled || forking.chainId !== 296) this.skip();
  });

  it("reads HBAR/USD from the Chainlink Data Feed", async function () {
    const feed = await ethers.getContractAt("AggregatorV3Interface", CHAINLINK_HBAR_USD);
    const [, answer, , updatedAt] = await feed.latestRoundData();

    expect(await feed.decimals()).to.equal(8n);
    expect(answer).to.be.gt(0n);
    expect(updatedAt).to.be.lte(BigInt(await time.latest()));
  });

  it("prices a market from Chainlink and cross-checks it against Supra", async function () {
    const [owner] = await ethers.getSigners();
    const collateral = await ethers.deployContract("MockCollateral");
    const engine = await ethers.deployContract("PerpEngine", [
      owner.address,
      collateral,
      config,
      // A wide tolerance: this asserts that both live feeds are read, not how closely they agree today.
      { supra: SUPRA_PUSH_ORACLE, supraMaxAge: 7 * DAY, maxDeviationBps: 2000 },
    ]);
    await engine.listMarket("HBAR/USD", CHAINLINK_HBAR_USD, 7 * DAY, 10, true, SUPRA_HBAR_USDT_PAIR);

    const feed = await ethers.getContractAt("AggregatorV3Interface", CHAINLINK_HBAR_USD);
    const [, answer] = await feed.latestRoundData();
    expect(await engine.markPrice(0)).to.equal(answer * 10n ** 10n); // 8 decimals scaled to 18

    const supra = await ethers.getContractAt("ISupraSValueFeed", SUPRA_PUSH_ORACLE);
    const value = await supra.getSvalue(SUPRA_HBAR_USDT_PAIR);
    expect(value.price).to.be.gt(0n);
    expect(value.decimals).to.equal(18n);
  });
});
