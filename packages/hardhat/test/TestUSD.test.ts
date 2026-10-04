import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";

// These tests run against the HTS system contract at 0x167, emulated by @hashgraph/system-contracts-forking
// on a fork of Hedera testnet. They exercise the same calls the contract makes on a live network.

const DAY = 24 * 3600;
const DRIP = ethers.parseUnits("1000", 6);
// The emulator, like the Hedera EVM, reads msg.value in tinybars: this is 1 HBAR for the HTS creation fee.
const HTS_CREATE_VALUE = 100_000_000n;

async function fixture() {
  const [owner, alice, bob] = await ethers.getSigners();

  const testUsd = await ethers.deployContract("TestUSD", [owner.address, DRIP, DAY]);
  await testUsd.createToken("Tinyperp Test USD", "tUSD", { value: HTS_CREATE_VALUE });

  const tokenAddress = await testUsd.token();
  const token = await ethers.getContractAt("MockCollateral", tokenAddress); // ERC-20 + HIP-719 ABI
  return { testUsd, token, tokenAddress, owner, alice, bob };
}

describe("TestUSD", function () {
  it("creates an HTS token once", async function () {
    const { testUsd, tokenAddress } = await loadFixture(fixture);

    expect(tokenAddress).to.not.equal(ethers.ZeroAddress);
    await expect(testUsd.createToken("Again", "AGN", { value: HTS_CREATE_VALUE })).to.be.revertedWithCustomError(
      testUsd,
      "TokenAlreadyCreated",
    );
  });

  it("only lets the owner create the token", async function () {
    const [owner, alice] = await ethers.getSigners();
    const testUsd = await ethers.deployContract("TestUSD", [owner.address, DRIP, DAY]);

    await expect(
      testUsd.connect(alice).createToken("Tinyperp Test USD", "tUSD", { value: HTS_CREATE_VALUE }),
    ).to.be.revertedWithCustomError(testUsd, "OwnableUnauthorizedAccount");
    await expect(testUsd.drip()).to.be.revertedWithCustomError(testUsd, "TokenNotCreated");
  });

  it("drips to an associated account, once per cooldown", async function () {
    const { testUsd, token, alice } = await loadFixture(fixture);
    await token.connect(alice).associate();

    await expect(testUsd.connect(alice).drip()).to.emit(testUsd, "Dripped").withArgs(alice.address, DRIP);
    expect(await token.balanceOf(alice.address)).to.equal(DRIP);

    await expect(testUsd.connect(alice).drip()).to.be.revertedWithCustomError(testUsd, "DripOnCooldown");
    await time.increase(DAY);
    await testUsd.connect(alice).drip();
    expect(await token.balanceOf(alice.address)).to.equal(DRIP * 2n);
  });

  it("lets the owner mint any amount, to seed the pool", async function () {
    const { testUsd, token, alice, bob } = await loadFixture(fixture);
    await token.connect(bob).associate();
    const amount = ethers.parseUnits("250000", 6);

    await expect(testUsd.connect(alice).mintTo(bob.address, amount)).to.be.revertedWithCustomError(
      testUsd,
      "OwnableUnauthorizedAccount",
    );
    await testUsd.mintTo(bob.address, amount);
    expect(await token.balanceOf(bob.address)).to.equal(amount);
  });
});
