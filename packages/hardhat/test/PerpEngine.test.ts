import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, setCode, time } from "@nomicfoundation/hardhat-network-helpers";

const HSS_ADDRESS = "0x000000000000000000000000000000000000016b";
const HBAR_PAIR = 75n;
const HOUR = 3600;
const DAY = 24 * HOUR;
const AUTO_SETTLE_FEE = ethers.parseEther("0.5");

const usd = (amount: string) => ethers.parseUnits(amount, 6);
const feedPrice = (amount: string) => ethers.parseUnits(amount, 8);
const price18 = (amount: string) => ethers.parseUnits(amount, 18);

const baseConfig = {
  openFeeBps: 0,
  spreadBps: 0,
  liquidationThresholdBps: 1000,
  liquidatorRewardBps: 500,
  maxProfitMultiple: 4,
  minDuration: 60,
  maxDuration: 7 * DAY,
  autoSettleGasLimit: 1_000_000,
  scheduleCallGas: 1_500_000,
  minCollateral: usd("1"),
  autoSettleFee: AUTO_SETTLE_FEE,
};

async function deploy(configOverrides: Partial<typeof baseConfig> = {}) {
  const [owner, lp, trader, liquidator, other] = await ethers.getSigners();

  const collateral = await ethers.deployContract("MockCollateral");
  const hbarFeed = await ethers.deployContract("MockAggregator", [8, "HBAR / USD", feedPrice("0.10")]);
  const btcFeed = await ethers.deployContract("MockAggregator", [8, "BTC / USD", feedPrice("80000")]);
  const supra = await ethers.deployContract("MockSupraFeed");
  await supra.setValue(HBAR_PAIR, price18("0.10"));

  // The Schedule Service is a system contract on Hedera. Locally, put a mock at its address.
  const scheduleServiceCode = await ethers.deployContract("MockScheduleService");
  await setCode(HSS_ADDRESS, (await ethers.provider.getCode(scheduleServiceCode)) as string);
  const scheduleService = await ethers.getContractAt("MockScheduleService", HSS_ADDRESS);

  const engine = await ethers.deployContract("PerpEngine", [
    owner.address,
    collateral,
    { ...baseConfig, ...configOverrides },
    { supra, supraMaxAge: HOUR, maxDeviationBps: 200 },
  ]);

  await engine.listMarket("HBAR/USD", hbarFeed, HOUR, 10, true, HBAR_PAIR);
  await engine.listMarket("BTC/USD", btcFeed, DAY, 5, false, 0);

  for (const account of [lp, trader, liquidator, other]) {
    await collateral.mint(account.address, usd("100000"));
    await collateral.connect(account).approve(engine, ethers.MaxUint256);
  }
  await engine.connect(lp).deposit(usd("10000"));

  return { engine, collateral, hbarFeed, btcFeed, supra, scheduleService, owner, lp, trader, liquidator, other };
}

const cleanFixture = () => deploy();
const feeFixture = () => deploy({ openFeeBps: 10, spreadBps: 5 });

type Deployment = Awaited<ReturnType<typeof deploy>>;

/** Opens a position on the HBAR market with no slippage limit and returns its id. */
async function open(
  { engine, trader }: Deployment,
  { isLong = true, collateral = "100", leverage = 5, duration = DAY, autoSettle = false } = {},
) {
  const positionId = await engine.nextPositionId();
  const acceptablePrice = isLong ? ethers.MaxUint256 : 0n;
  await engine
    .connect(trader)
    .openPosition(0, isLong, usd(collateral), leverage, duration, acceptablePrice, autoSettle, {
      value: autoSettle ? AUTO_SETTLE_FEE : 0n,
    });
  return positionId;
}

/** Moves the HBAR price on both oracles, the way a real market move shows up on Chainlink and Supra. */
async function setHbarPrice({ hbarFeed, supra }: Deployment, price: string) {
  await hbarFeed.setAnswer(feedPrice(price));
  await supra.setValue(HBAR_PAIR, price18(price));
}

/** The engine must always hold exactly what it owes to the pool, to traders and to pending claims. */
async function expectSolvent({ engine, collateral }: Deployment) {
  const owed = (await engine.poolAssets()) + (await engine.totalMargin()) + (await engine.totalClaimable());
  expect(await collateral.balanceOf(engine)).to.equal(owed);
  expect(await engine.reservedAssets()).to.be.lte(await engine.poolAssets());
}

describe("PerpEngine", function () {
  describe("deployment", function () {
    it("associates itself with the collateral token", async function () {
      const { engine, collateral } = await loadFixture(cleanFixture);
      expect(await collateral.associated(engine)).to.equal(true);
    });

    it("rejects a config whose liquidator reward exceeds the liquidation threshold", async function () {
      const { collateral, owner, supra } = await loadFixture(cleanFixture);
      const factory = await ethers.getContractFactory("PerpEngine");
      const config = { ...baseConfig, liquidatorRewardBps: 1001 };
      const guard = { supra, supraMaxAge: HOUR, maxDeviationBps: 200 };
      await expect(factory.deploy(owner.address, collateral, config, guard)).to.be.revertedWithCustomError(
        factory,
        "InvalidConfig",
      );
    });

    it("lets only the owner list markets", async function () {
      const { engine, hbarFeed, trader } = await loadFixture(cleanFixture);
      await expect(
        engine.connect(trader).listMarket("X/USD", hbarFeed, HOUR, 5, false, 0),
      ).to.be.revertedWithCustomError(engine, "OwnableUnauthorizedAccount");
      expect(await engine.marketCount()).to.equal(2n);
    });
  });

  describe("liquidity pool", function () {
    it("mints the first shares one to one", async function () {
      const { engine, lp } = await loadFixture(cleanFixture);
      expect(await engine.sharesOf(lp.address)).to.equal(usd("10000"));
      expect(await engine.poolAssets()).to.equal(usd("10000"));
    });

    it("prices later deposits at the share price after the pool has earned fees", async function () {
      const ctx = await loadFixture(feeFixture);
      const { engine, other } = ctx;
      await open(ctx, { collateral: "1000", leverage: 10 }); // fee: 1000 * 10 * 0.1% = 10

      expect(await engine.poolAssets()).to.equal(usd("10010"));
      await engine.connect(other).deposit(usd("1001"));
      expect(await engine.sharesOf(other.address)).to.equal(usd("1000"));
      await expectSolvent(ctx);
    });

    it("keeps reserved liquidity in the pool until positions settle", async function () {
      const ctx = await loadFixture(cleanFixture);
      const { engine, lp } = ctx;
      await open(ctx, { collateral: "1000" }); // reserves 4000

      expect(await engine.freeLiquidity()).to.equal(usd("6000"));
      await expect(engine.connect(lp).withdraw(usd("6001"))).to.be.revertedWithCustomError(
        engine,
        "InsufficientLiquidity",
      );
      await expect(engine.connect(lp).withdraw(usd("6000")))
        .to.emit(engine, "LiquidityRemoved")
        .withArgs(lp.address, usd("6000"), usd("6000"));
      await expectSolvent(ctx);
    });
  });

  describe("opening", function () {
    it("charges the open fee to the pool and enters at the oracle price plus spread", async function () {
      const ctx = await loadFixture(feeFixture);
      const { engine, trader } = ctx;
      const positionId = await open(ctx);

      const position = await engine.getPosition(positionId);
      expect(position.owner).to.equal(trader.address);
      expect(position.margin).to.equal(usd("99.5")); // 100 - 100 * 5 * 0.1%
      expect(position.size).to.equal(usd("497.5"));
      expect(position.reserved).to.equal(usd("398"));
      expect(position.entryPrice).to.equal(price18("0.10005"));
      expect(await engine.poolAssets()).to.equal(usd("10000.5"));
      expect(await engine.openPositionIdsOf(trader.address)).to.deep.equal([positionId]);
      await expectSolvent(ctx);
    });

    it("enters shorts below the oracle price", async function () {
      const ctx = await loadFixture(feeFixture);
      const positionId = await open(ctx, { isLong: false });
      expect((await ctx.engine.getPosition(positionId)).entryPrice).to.equal(price18("0.09995"));
    });

    it("rejects requests outside the market's limits", async function () {
      const { engine, trader } = await loadFixture(cleanFixture);
      const max = ethers.MaxUint256;
      const connected = engine.connect(trader);

      await expect(connected.openPosition(0, true, usd("100"), 11, DAY, max, false)).to.be.revertedWithCustomError(
        engine,
        "InvalidLeverage",
      );
      await expect(connected.openPosition(0, true, usd("0.5"), 5, DAY, max, false)).to.be.revertedWithCustomError(
        engine,
        "CollateralTooSmall",
      );
      await expect(connected.openPosition(0, true, usd("100"), 5, 30, max, false)).to.be.revertedWithCustomError(
        engine,
        "InvalidDuration",
      );
      await expect(connected.openPosition(9, true, usd("100"), 5, DAY, max, false)).to.be.revertedWithCustomError(
        engine,
        "MarketNotFound",
      );
      await expect(connected.openPosition(0, true, usd("2501"), 5, DAY, max, false)).to.be.revertedWithCustomError(
        engine,
        "InsufficientLiquidity",
      );
    });

    it("honours the caller's acceptable price", async function () {
      const { engine, trader } = await loadFixture(feeFixture);
      const connected = engine.connect(trader);

      await expect(connected.openPosition(0, true, usd("100"), 5, DAY, price18("0.10"), false))
        .to.be.revertedWithCustomError(engine, "PriceNotAcceptable")
        .withArgs(price18("0.10005"));
      await expect(connected.openPosition(0, false, usd("100"), 5, DAY, price18("0.10"), false))
        .to.be.revertedWithCustomError(engine, "PriceNotAcceptable")
        .withArgs(price18("0.09995"));
    });

    it("stops new positions on a close-only market but still lets existing ones close", async function () {
      const ctx = await loadFixture(cleanFixture);
      const { engine, trader } = ctx;
      const positionId = await open(ctx);
      await engine.setMarketOpenEnabled(0, false);

      await expect(
        engine.connect(trader).openPosition(0, true, usd("100"), 5, DAY, ethers.MaxUint256, false),
      ).to.be.revertedWithCustomError(engine, "MarketClosed");
      await expect(engine.connect(trader).closePosition(positionId)).to.emit(engine, "PositionSettled");
    });
  });

  describe("closing", function () {
    it("pays a long its profit when the price rises", async function () {
      const ctx = await loadFixture(cleanFixture);
      const { engine, collateral, trader } = ctx;
      const positionId = await open(ctx); // 100 margin, 500 notional
      await setHbarPrice(ctx, "0.11"); // +10% on 500 = +50

      await expect(engine.connect(trader).closePosition(positionId)).to.changeTokenBalance(
        collateral,
        trader,
        usd("150"),
      );
      expect(await engine.poolAssets()).to.equal(usd("9950"));
      expect(await engine.reservedAssets()).to.equal(0n);
      expect(await engine.openPositionIdsOf(trader.address)).to.deep.equal([]);
      await expectSolvent(ctx);
    });

    it("pays a long its remaining margin when the price falls", async function () {
      const ctx = await loadFixture(cleanFixture);
      const { engine, collateral, trader } = ctx;
      const positionId = await open(ctx);
      await setHbarPrice(ctx, "0.09"); // -10% on 500 = -50

      await expect(engine.connect(trader).closePosition(positionId)).to.changeTokenBalance(
        collateral,
        trader,
        usd("50"),
      );
      expect(await engine.poolAssets()).to.equal(usd("10050"));
      await expectSolvent(ctx);
    });

    it("pays a short its profit when the price falls", async function () {
      const ctx = await loadFixture(cleanFixture);
      const { engine, trader } = ctx;
      const positionId = await open(ctx, { isLong: false });
      await setHbarPrice(ctx, "0.09");

      await expect(engine.connect(trader).closePosition(positionId))
        .to.emit(engine, "PositionSettled")
        .withArgs(positionId, trader.address, 0, price18("0.09"), usd("50"), usd("150"), trader.address, 0);
    });

    it("caps profit at the liquidity reserved for the position", async function () {
      const ctx = await loadFixture(cleanFixture);
      const { engine, collateral, trader } = ctx;
      const positionId = await open(ctx);
      await setHbarPrice(ctx, "0.20"); // +100% on 500 = +500, cap is 4 x 100

      await expect(engine.connect(trader).closePosition(positionId)).to.changeTokenBalance(
        collateral,
        trader,
        usd("500"),
      );
      expect(await engine.poolAssets()).to.equal(usd("9600"));
      await expectSolvent(ctx);
    });

    it("charges the spread again on exit", async function () {
      const ctx = await loadFixture(feeFixture);
      const { engine, trader } = ctx;
      const positionId = await open(ctx);

      const status = await engine.positionStatus(positionId);
      expect(status.exitPrice).to.equal(price18("0.09995"));
      expect(status.pnl).to.be.lt(0n);
      await expect(engine.connect(trader).closePosition(positionId)).to.emit(engine, "PositionSettled");
      await expectSolvent(ctx);
    });

    it("only lets the owner close a position", async function () {
      const ctx = await loadFixture(cleanFixture);
      const positionId = await open(ctx);
      await expect(ctx.engine.connect(ctx.other).closePosition(positionId)).to.be.revertedWithCustomError(
        ctx.engine,
        "NotPositionOwner",
      );
    });

    it("keeps each owner's open position list correct as positions close out of order", async function () {
      const ctx = await loadFixture(cleanFixture);
      const { engine, trader } = ctx;
      const first = await open(ctx);
      const second = await open(ctx);
      const third = await open(ctx);

      await engine.connect(trader).closePosition(first);
      expect(await engine.openPositionIdsOf(trader.address)).to.deep.equal([third, second]);
      await engine.connect(trader).closePosition(third);
      expect(await engine.openPositionIdsOf(trader.address)).to.deep.equal([second]);
      await expect(engine.getPosition(first)).to.be.revertedWithCustomError(engine, "PositionNotFound");
    });
  });

  describe("liquidation", function () {
    it("refuses to liquidate a healthy position", async function () {
      const ctx = await loadFixture(cleanFixture);
      const positionId = await open(ctx);
      await setHbarPrice(ctx, "0.085"); // equity 25, threshold 10

      expect((await ctx.engine.positionStatus(positionId)).liquidatable).to.equal(false);
      await expect(ctx.engine.connect(ctx.liquidator).liquidate(positionId)).to.be.revertedWithCustomError(
        ctx.engine,
        "NotLiquidatable",
      );
    });

    it("rewards the liquidator and returns what is left to the trader", async function () {
      const ctx = await loadFixture(cleanFixture);
      const { engine, collateral, trader, liquidator } = ctx;
      const positionId = await open(ctx);
      await setHbarPrice(ctx, "0.0816"); // -18.4% on 500 = -92, equity 8

      expect((await engine.positionStatus(positionId)).liquidatable).to.equal(true);
      await expect(engine.connect(liquidator).liquidate(positionId)).to.changeTokenBalances(
        collateral,
        [liquidator, trader],
        [usd("5"), usd("3")],
      );
      expect(await engine.poolAssets()).to.equal(usd("10092"));
      await expectSolvent(ctx);
    });

    it("gives the pool the whole margin, less the reward, when a position is wiped out", async function () {
      const ctx = await loadFixture(cleanFixture);
      const { engine, collateral, trader, liquidator } = ctx;
      const positionId = await open(ctx);
      await setHbarPrice(ctx, "0.05");

      await expect(engine.connect(liquidator).liquidate(positionId)).to.changeTokenBalances(
        collateral,
        [liquidator, trader],
        [usd("5"), 0n],
      );
      expect(await engine.poolAssets()).to.equal(usd("10095"));
      await expectSolvent(ctx);
    });

    it("settles even when the trader can no longer receive the token", async function () {
      const ctx = await loadFixture(cleanFixture);
      const { engine, collateral, lp, trader, liquidator } = ctx;
      const positionId = await open(ctx);
      await setHbarPrice(ctx, "0.0816");

      // On Hedera an account that is not associated with an HTS token cannot receive it.
      await collateral.connect(lp).associate();
      await collateral.connect(liquidator).associate();
      await collateral.setEnforceAssociation(true);

      await expect(engine.connect(liquidator).liquidate(positionId))
        .to.emit(engine, "PayoutDeferred")
        .withArgs(trader.address, usd("3"));
      expect(await engine.claimable(trader.address)).to.equal(usd("3"));
      await expectSolvent(ctx);

      await collateral.connect(trader).associate();
      await expect(engine.connect(trader).claim()).to.changeTokenBalance(collateral, trader, usd("3"));
      expect(await engine.totalClaimable()).to.equal(0n);
      await expectSolvent(ctx);
    });
  });

  describe("expiry and scheduled settlement", function () {
    it("lets anyone settle a position once its term has ended", async function () {
      const ctx = await loadFixture(cleanFixture);
      const { engine, collateral, trader, other } = ctx;
      const positionId = await open(ctx, { duration: HOUR });

      await expect(engine.connect(other).settleExpired(positionId)).to.be.revertedWithCustomError(engine, "NotExpired");
      await time.increase(HOUR);
      await setHbarPrice(ctx, "0.10");

      await expect(engine.connect(other).settleExpired(positionId)).to.changeTokenBalance(
        collateral,
        trader,
        usd("100"),
      );
      await expectSolvent(ctx);
    });

    it("books a schedule that settles the position with no keeper", async function () {
      const ctx = await loadFixture(cleanFixture);
      const { engine, collateral, scheduleService, trader } = ctx;
      const positionId = await open(ctx, { duration: HOUR, autoSettle: true });

      const position = await engine.getPosition(positionId);
      const booked = await scheduleService.scheduled(position.schedule);
      expect(booked.to).to.equal(await engine.getAddress());
      expect(booked.expirySecond).to.equal(position.expiresAt);
      expect(booked.callData).to.equal(engine.interface.encodeFunctionData("settleExpired", [positionId]));
      expect(position.settleDeposit).to.equal(AUTO_SETTLE_FEE);
      expect(await ethers.provider.getBalance(engine)).to.equal(AUTO_SETTLE_FEE);

      await time.increase(HOUR);
      await setHbarPrice(ctx, "0.11");

      await expect(scheduleService.execute(position.schedule)).to.changeTokenBalance(collateral, trader, usd("150"));
      await expectSolvent(ctx);
    });

    it("cancels the schedule and refunds the prepaid fee when the position closes early", async function () {
      const ctx = await loadFixture(cleanFixture);
      const { engine, scheduleService, trader } = ctx;
      const positionId = await open(ctx, { autoSettle: true });
      const { schedule } = await engine.getPosition(positionId);

      await expect(engine.connect(trader).closePosition(positionId)).to.changeEtherBalances(
        [engine, trader],
        [-AUTO_SETTLE_FEE, AUTO_SETTLE_FEE],
      );
      expect((await scheduleService.scheduled(schedule)).deleted).to.equal(true);
    });

    it("keeps the prepaid fee when the schedule cannot be cancelled", async function () {
      const ctx = await loadFixture(cleanFixture);
      const { engine, scheduleService, trader } = ctx;
      const positionId = await open(ctx, { autoSettle: true });
      await scheduleService.setRejectDeletes(true);

      await expect(engine.connect(trader).closePosition(positionId)).to.changeEtherBalance(engine, 0n);
    });

    it("opens the position without charging the fee when scheduling fails", async function () {
      const ctx = await loadFixture(cleanFixture);
      const { engine, scheduleService, trader } = ctx;
      await scheduleService.setRejectSchedules(true);

      const positionId = await engine.nextPositionId();
      const tx = engine
        .connect(trader)
        .openPosition(0, true, usd("100"), 5, DAY, ethers.MaxUint256, true, { value: AUTO_SETTLE_FEE });
      await expect(tx).to.emit(engine, "AutoSettleSkipped").withArgs(positionId);
      await expect(tx).to.changeEtherBalance(engine, 0n);
      expect((await engine.getPosition(positionId)).schedule).to.equal(ethers.ZeroAddress);
    });

    it("opens the position without booking when the network has no room at the expiry second", async function () {
      const ctx = await loadFixture(cleanFixture);
      const { engine, scheduleService, trader } = ctx;
      await scheduleService.setNoCapacity(true);

      const positionId = await engine.nextPositionId();
      const tx = engine
        .connect(trader)
        .openPosition(0, true, usd("100"), 5, DAY, ethers.MaxUint256, true, { value: AUTO_SETTLE_FEE });
      await expect(tx).to.emit(engine, "AutoSettleSkipped").withArgs(positionId);
      await expect(tx).to.changeEtherBalance(engine, 0n);
      expect(await scheduleService.scheduleCount()).to.equal(0n);
    });

    it("refuses an auto-settle open that cannot afford to book the schedule", async function () {
      const { engine, trader } = await loadFixture(cleanFixture);

      // Booking forwards 1.5 million gas and keeps 400,000 for the rest of the open.
      await expect(
        engine.connect(trader).openPosition(0, true, usd("100"), 5, DAY, ethers.MaxUint256, true, {
          value: AUTO_SETTLE_FEE,
          gasLimit: 1_200_000,
        }),
      )
        .to.be.revertedWithCustomError(engine, "AutoSettleNeedsMoreGas")
        .withArgs(1_900_000);
    });

    it("requires the fee up front and returns anything paid beyond it", async function () {
      const { engine, trader } = await loadFixture(cleanFixture);
      const connected = engine.connect(trader);

      await expect(connected.openPosition(0, true, usd("100"), 5, DAY, ethers.MaxUint256, true))
        .to.be.revertedWithCustomError(engine, "AutoSettleFeeTooLow")
        .withArgs(AUTO_SETTLE_FEE);
      await expect(
        connected.openPosition(0, true, usd("100"), 5, DAY, ethers.MaxUint256, true, {
          value: AUTO_SETTLE_FEE * 3n,
        }),
      ).to.changeEtherBalance(engine, AUTO_SETTLE_FEE);
    });
  });

  describe("oracle guard", function () {
    it("refuses to trade on a stale Chainlink round", async function () {
      const ctx = await loadFixture(cleanFixture);
      const { engine, trader } = ctx;
      await time.increase(HOUR + 1);

      await expect(
        engine.connect(trader).openPosition(0, true, usd("100"), 5, DAY, ethers.MaxUint256, false),
      ).to.be.revertedWithCustomError(engine, "StaleOraclePrice");
      await expect(engine.markPrice(0)).to.be.revertedWithCustomError(engine, "StaleOraclePrice");
    });

    it("refuses a non-positive Chainlink answer", async function () {
      const { engine, hbarFeed } = await loadFixture(cleanFixture);
      await hbarFeed.setAnswer(0);
      await expect(engine.markPrice(0)).to.be.revertedWithCustomError(engine, "InvalidOraclePrice");
    });

    it("halts a cross-checked market while Chainlink and Supra disagree", async function () {
      const ctx = await loadFixture(cleanFixture);
      const { engine, supra, trader } = ctx;
      const positionId = await open(ctx);
      await supra.setValue(HBAR_PAIR, price18("0.103")); // 3% away, limit is 2%

      await expect(engine.markPrice(0))
        .to.be.revertedWithCustomError(engine, "OracleDeviationTooHigh")
        .withArgs(price18("0.10"), price18("0.103"));
      await expect(engine.connect(trader).closePosition(positionId)).to.be.revertedWithCustomError(
        engine,
        "OracleDeviationTooHigh",
      );

      await supra.setValue(HBAR_PAIR, price18("0.1015"));
      expect(await engine.markPrice(0)).to.equal(price18("0.10"));
    });

    it("ignores Supra when its value is stale or the feed is unavailable", async function () {
      const { engine, supra } = await loadFixture(cleanFixture);

      await supra.setValueAt(HBAR_PAIR, price18("0.50"), (await time.latest()) - 2 * HOUR);
      expect(await engine.markPrice(0)).to.equal(price18("0.10"));

      await supra.setValue(HBAR_PAIR, price18("0.50"));
      await supra.setBroken(true);
      expect(await engine.markPrice(0)).to.equal(price18("0.10"));
    });

    it("does not cross-check markets that opted out", async function () {
      const { engine } = await loadFixture(cleanFixture);
      expect(await engine.markPrice(1)).to.equal(price18("80000"));
    });
  });
});
