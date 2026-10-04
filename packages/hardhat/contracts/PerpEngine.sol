// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { AggregatorV3Interface } from "./interfaces/AggregatorV3Interface.sol";
import { ISupraSValueFeed } from "./interfaces/ISupraSValueFeed.sol";
import { IHederaScheduleService } from "./interfaces/IHederaScheduleService.sol";
import { IHRC719 } from "./interfaces/IHRC719.sol";
import { OracleLib } from "./libraries/OracleLib.sol";

/// @title PerpEngine
/// @notice Oracle-settled, fixed-term leveraged positions against a single liquidity pool.
/// @dev How the pieces fit:
///      - Prices come from Chainlink Data Feeds. A market can also be cross-checked against the Supra push
///        oracle, which halts the market while the two sources disagree.
///      - Collateral is one HTS token, used through its ERC-20 facade. The engine associates itself with it.
///      - Every position reserves its maximum profit from the pool when it opens, so the pool can always pay.
///      - Positions have a term instead of a funding rate. At the end of the term anyone can settle them, and a
///        trader can prepay the Hedera Schedule Service to do it with no keeper.
contract PerpEngine is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum SettleReason {
        Closed,
        Liquidated,
        Expired
    }

    /// @param openFeeBps Fee on notional charged at open and paid to the pool.
    /// @param spreadBps Spread applied against the trader on entry and on exit.
    /// @param liquidationThresholdBps A position is liquidatable once its equity is at or below this share of margin.
    /// @param liquidatorRewardBps Share of margin paid to whoever liquidates.
    /// @param maxProfitMultiple Profit cap as a multiple of margin. This much pool liquidity is reserved per position.
    /// @param minDuration Shortest position term, in seconds.
    /// @param maxDuration Longest position term, in seconds.
    /// @param autoSettleGasLimit Gas limit of the scheduled settlement call. Zero turns scheduling off.
    /// @param scheduleCallGas Gas forwarded to the Schedule Service to book a settlement. Booking costs about
    ///        1.41 million gas on Hedera.
    /// @param minCollateral Smallest collateral accepted at open.
    /// @param autoSettleFee Native amount that prepays a scheduled settlement, in the unit of `msg.value`
    ///        (tinybars on Hedera).
    struct Config {
        uint16 openFeeBps;
        uint16 spreadBps;
        uint16 liquidationThresholdBps;
        uint16 liquidatorRewardBps;
        uint16 maxProfitMultiple;
        uint32 minDuration;
        uint32 maxDuration;
        uint32 autoSettleGasLimit;
        uint32 scheduleCallGas;
        uint256 minCollateral;
        uint256 autoSettleFee;
    }

    /// @param supra Supra push oracle. Zero address turns the cross-check off for every market.
    /// @param supraMaxAge A Supra value older than this many seconds is ignored.
    /// @param maxDeviationBps Largest tolerated difference between Chainlink and a fresh Supra value.
    struct OracleGuard {
        ISupraSValueFeed supra;
        uint32 supraMaxAge;
        uint16 maxDeviationBps;
    }

    struct Market {
        string symbol;
        AggregatorV3Interface feed;
        uint8 feedDecimals;
        uint32 maxPriceAge;
        uint16 maxLeverage;
        bool openEnabled;
        bool crossCheck;
        uint64 supraPairIndex;
    }

    /// @param margin Collateral left after the open fee.
    /// @param size Notional, `margin * leverage`.
    /// @param reserved Pool liquidity held to cover the profit cap.
    /// @param entryPrice Entry price with spread, 18 decimals.
    /// @param schedule Hedera schedule that settles the position at expiry, zero if none.
    /// @param settleDeposit Native amount held to pay for that schedule.
    struct Position {
        address owner;
        uint32 marketId;
        bool isLong;
        uint64 openedAt;
        uint64 expiresAt;
        uint256 margin;
        uint256 size;
        uint256 reserved;
        uint256 entryPrice;
        address schedule;
        uint256 settleDeposit;
    }

    uint256 internal constant BPS = 10_000;
    address internal constant HSS = address(0x16b);
    int64 internal constant HEDERA_SUCCESS = 22;
    uint256 internal constant TOKEN_ALREADY_ASSOCIATED = 194;
    /// @dev Gas an open still needs after booking its settlement: storing the position and pulling collateral.
    uint256 internal constant GAS_RESERVED_AFTER_SCHEDULING = 400_000;
    uint256 internal constant SCHEDULE_CAPACITY_GAS = 50_000;
    uint256 internal constant DELETE_SCHEDULE_GAS = 300_000;
    /// @dev A Hedera block's timestamp is that of its first transaction and blocks last two seconds, so a call
    ///      the network runs at second T can see a `block.timestamp` just before T. Booking the settlement a
    ///      few seconds after expiry keeps it from failing the expiry check.
    uint256 internal constant SETTLE_DELAY = 5;

    IERC20 public immutable collateral;
    Config public config;
    OracleGuard public oracleGuard;

    /// @notice Collateral owned by liquidity providers, including the part reserved for open positions.
    uint256 public poolAssets;
    /// @notice Part of `poolAssets` reserved to cover the profit caps of open positions.
    uint256 public reservedAssets;
    /// @notice Sum of the margins of open positions. Held by the engine, not owned by the pool.
    uint256 public totalMargin;
    /// @notice Payouts that could not be delivered and wait in `claimable`.
    uint256 public totalClaimable;
    uint256 public totalShares;
    uint256 public nextPositionId = 1;

    mapping(address provider => uint256 shares) public sharesOf;
    mapping(address account => uint256 amount) public claimable;

    Market[] private _markets;
    mapping(uint256 positionId => Position) private _positions;
    mapping(address owner => uint256[] positionIds) private _openIds;
    mapping(uint256 positionId => uint256 index) private _openIdIndex;

    event CollateralAssociation(bool associated, uint256 responseCode);
    event MarketListed(uint256 indexed marketId, string symbol, address feed, uint16 maxLeverage, bool crossCheck);
    event MarketOpenEnabledSet(uint256 indexed marketId, bool enabled);
    event LiquidityAdded(address indexed provider, uint256 assets, uint256 shares);
    event LiquidityRemoved(address indexed provider, uint256 assets, uint256 shares);
    event PositionOpened(
        uint256 indexed positionId,
        address indexed owner,
        uint256 indexed marketId,
        bool isLong,
        uint256 margin,
        uint256 size,
        uint256 entryPrice,
        uint64 expiresAt,
        address schedule
    );
    event PositionSettled(
        uint256 indexed positionId,
        address indexed owner,
        SettleReason reason,
        uint256 exitPrice,
        int256 pnl,
        uint256 payout,
        address settler,
        uint256 settlerReward
    );
    event AutoSettleSkipped(uint256 indexed positionId);
    event PayoutDeferred(address indexed account, uint256 amount);
    event Claimed(address indexed account, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error InvalidConfig();
    error MarketNotFound(uint256 marketId);
    error MarketClosed(uint256 marketId);
    error InvalidLeverage();
    error InvalidDuration();
    error CollateralTooSmall();
    error PriceNotAcceptable(uint256 entryPrice);
    error InsufficientLiquidity();
    error InsufficientShares();
    error PoolDepleted();
    error PositionNotFound(uint256 positionId);
    error NotPositionOwner();
    error NotLiquidatable();
    error NotExpired();
    error AutoSettleFeeTooLow(uint256 required);
    error AutoSettleNeedsMoreGas(uint256 required);
    error NativeTransferFailed();

    constructor(
        address owner_,
        IERC20 collateral_,
        Config memory config_,
        OracleGuard memory oracleGuard_
    ) Ownable(owner_) {
        if (address(collateral_) == address(0)) revert ZeroAddress();
        if (
            config_.openFeeBps >= BPS ||
            config_.spreadBps >= BPS ||
            config_.liquidationThresholdBps >= BPS ||
            config_.liquidatorRewardBps > config_.liquidationThresholdBps ||
            config_.maxProfitMultiple == 0 ||
            config_.minDuration == 0 ||
            config_.minDuration > config_.maxDuration
        ) revert InvalidConfig();
        if (
            address(oracleGuard_.supra) != address(0) &&
            (oracleGuard_.supraMaxAge == 0 || oracleGuard_.maxDeviationBps == 0)
        ) revert InvalidConfig();

        collateral = collateral_;
        config = config_;
        oracleGuard = oracleGuard_;
        associateCollateral();
    }

    /// @notice Accepts HBAR that tops up the budget for scheduled settlements.
    receive() external payable {}

    // ----------------------------------------------------------------------------------------------------------
    // Admin
    // ----------------------------------------------------------------------------------------------------------

    /// @notice Lists a market priced by a Chainlink Data Feed.
    /// @param maxPriceAge Oldest Chainlink round, in seconds, the market will trade on.
    /// @param crossCheck Whether to compare the price against Supra pair `supraPairIndex`.
    function listMarket(
        string calldata symbol,
        AggregatorV3Interface feed,
        uint32 maxPriceAge,
        uint16 maxLeverage,
        bool crossCheck,
        uint64 supraPairIndex
    ) external onlyOwner returns (uint256 marketId) {
        if (address(feed) == address(0)) revert ZeroAddress();
        if (maxPriceAge == 0 || maxLeverage == 0) revert InvalidConfig();

        marketId = _markets.length;
        _markets.push(
            Market({
                symbol: symbol,
                feed: feed,
                feedDecimals: feed.decimals(),
                maxPriceAge: maxPriceAge,
                maxLeverage: maxLeverage,
                openEnabled: true,
                crossCheck: crossCheck,
                supraPairIndex: supraPairIndex
            })
        );
        emit MarketListed(marketId, symbol, address(feed), maxLeverage, crossCheck);
    }

    /// @notice Puts a market in close-only mode, or reopens it.
    function setMarketOpenEnabled(uint256 marketId, bool enabled) external onlyOwner {
        _market(marketId).openEnabled = enabled;
        emit MarketOpenEnabledSet(marketId, enabled);
    }

    /// @notice Withdraws HBAR from the scheduled-settlement budget.
    function sweepNative(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, ) = to.call{ value: amount }("");
        if (!ok) revert NativeTransferFailed();
    }

    /// @notice Associates the engine with the collateral token so it can hold it (HIP-719).
    /// @dev Runs in the constructor and is safe to call again. Never reverts: a token without `associate()` is
    ///      treated as a plain ERC-20 that needs no association.
    function associateCollateral() public returns (bool associated) {
        (bool ok, bytes memory ret) = address(collateral).call(abi.encodeCall(IHRC719.associate, ()));
        uint256 responseCode = ok && ret.length == 32 ? abi.decode(ret, (uint256)) : 0;
        associated = responseCode == uint256(uint64(HEDERA_SUCCESS)) || responseCode == TOKEN_ALREADY_ASSOCIATED;
        emit CollateralAssociation(associated, responseCode);
    }

    // ----------------------------------------------------------------------------------------------------------
    // Liquidity pool
    // ----------------------------------------------------------------------------------------------------------

    /// @notice Adds collateral to the pool and mints shares at the current share price.
    function deposit(uint256 assets) external nonReentrant returns (uint256 shares) {
        shares = previewDeposit(assets);
        if (shares == 0) revert ZeroAmount();

        poolAssets += assets;
        totalShares += shares;
        sharesOf[msg.sender] += shares;

        collateral.safeTransferFrom(msg.sender, address(this), assets);
        emit LiquidityAdded(msg.sender, assets, shares);
    }

    /// @notice Burns shares for collateral. Only liquidity not reserved by open positions can leave.
    function withdraw(uint256 shares) external nonReentrant returns (uint256 assets) {
        if (shares == 0) revert ZeroAmount();
        if (shares > sharesOf[msg.sender]) revert InsufficientShares();

        assets = previewWithdraw(shares);
        if (assets > freeLiquidity()) revert InsufficientLiquidity();

        sharesOf[msg.sender] -= shares;
        totalShares -= shares;
        poolAssets -= assets;

        collateral.safeTransfer(msg.sender, assets);
        emit LiquidityRemoved(msg.sender, assets, shares);
    }

    // ----------------------------------------------------------------------------------------------------------
    // Trading
    // ----------------------------------------------------------------------------------------------------------

    /// @notice Opens a leveraged position at the current oracle price plus spread.
    /// @param collateralAmount Collateral pulled from the caller. The open fee is taken from it.
    /// @param leverage Whole-number multiple, from 1 to the market's `maxLeverage`.
    /// @param duration Term in seconds. After it, anyone can settle the position.
    /// @param acceptablePrice Worst entry price the caller accepts: a ceiling for longs, a floor for shorts.
    /// @param autoSettle Prepay `config.autoSettleFee` so the Schedule Service settles the position at expiry.
    ///        Any `msg.value` beyond the fee is returned.
    function openPosition(
        uint256 marketId,
        bool isLong,
        uint256 collateralAmount,
        uint256 leverage,
        uint256 duration,
        uint256 acceptablePrice,
        bool autoSettle
    ) external payable nonReentrant returns (uint256 positionId) {
        Config memory cfg = config;
        Position memory position = _newPosition(
            marketId,
            isLong,
            collateralAmount,
            leverage,
            duration,
            acceptablePrice,
            cfg
        );

        positionId = nextPositionId++;
        (position.schedule, position.settleDeposit) = _prepaySettlement(
            positionId,
            position.expiresAt,
            autoSettle,
            cfg
        );

        _positions[positionId] = position;
        _openIdIndex[positionId] = _openIds[msg.sender].length;
        _openIds[msg.sender].push(positionId);

        collateral.safeTransferFrom(msg.sender, address(this), collateralAmount);
        if (msg.value > position.settleDeposit) _sendNative(msg.sender, msg.value - position.settleDeposit, true);

        emit PositionOpened(
            positionId,
            msg.sender,
            marketId,
            isLong,
            position.margin,
            position.size,
            position.entryPrice,
            position.expiresAt,
            position.schedule
        );
    }

    /// @notice Closes the caller's position at the current oracle price minus spread.
    function closePosition(uint256 positionId) external nonReentrant returns (uint256 payout) {
        Position memory position = _position(positionId);
        if (position.owner != msg.sender) revert NotPositionOwner();
        (payout, ) = _settle(positionId, position, SettleReason.Closed);
    }

    /// @notice Closes an under-margined position. The caller earns `liquidatorRewardBps` of its margin.
    function liquidate(uint256 positionId) external nonReentrant returns (uint256 reward) {
        (, reward) = _settle(positionId, _position(positionId), SettleReason.Liquidated);
    }

    /// @notice Settles a position whose term has ended. Called by the Schedule Service, or by anyone.
    function settleExpired(uint256 positionId) external nonReentrant returns (uint256 payout) {
        (payout, ) = _settle(positionId, _position(positionId), SettleReason.Expired);
    }

    /// @notice Collects a payout that could not be delivered, for example because the account was not
    ///         associated with the collateral token when its position settled.
    function claim() external nonReentrant returns (uint256 amount) {
        amount = claimable[msg.sender];
        if (amount == 0) revert ZeroAmount();

        claimable[msg.sender] = 0;
        totalClaimable -= amount;

        collateral.safeTransfer(msg.sender, amount);
        emit Claimed(msg.sender, amount);
    }

    // ----------------------------------------------------------------------------------------------------------
    // Views
    // ----------------------------------------------------------------------------------------------------------

    function marketCount() external view returns (uint256) {
        return _markets.length;
    }

    function getMarket(uint256 marketId) external view returns (Market memory) {
        return _market(marketId);
    }

    function getPosition(uint256 positionId) external view returns (Position memory) {
        return _position(positionId);
    }

    function openPositionIdsOf(address owner_) external view returns (uint256[] memory) {
        return _openIds[owner_];
    }

    /// @notice Oracle price of a market, 18 decimals, before spread.
    /// @dev Reverts when the feed is stale or the oracle cross-check fails.
    function markPrice(uint256 marketId) external view returns (uint256) {
        return _markPrice(_market(marketId));
    }

    /// @notice What settling a position right now would produce.
    /// @return exitPrice Oracle price with spread, 18 decimals.
    /// @return pnl Payout minus margin.
    /// @return payout Collateral the position is worth.
    /// @return liquidatable Whether `liquidate` would succeed.
    /// @return expired Whether `settleExpired` would succeed.
    function positionStatus(
        uint256 positionId
    ) external view returns (uint256 exitPrice, int256 pnl, uint256 payout, bool liquidatable, bool expired) {
        Position memory position = _position(positionId);
        exitPrice = _withSpread(_markPrice(_markets[position.marketId]), config.spreadBps, !position.isLong);
        payout = _payoutAt(position, exitPrice);
        pnl = int256(payout) - int256(position.margin);
        liquidatable = _isLiquidatable(position, payout, config.liquidationThresholdBps);
        expired = block.timestamp >= position.expiresAt;
    }

    /// @notice Pool liquidity that is not reserved by open positions.
    function freeLiquidity() public view returns (uint256) {
        return poolAssets - reservedAssets;
    }

    function previewDeposit(uint256 assets) public view returns (uint256 shares) {
        if (totalShares == 0) return assets;
        if (poolAssets == 0) revert PoolDepleted();
        return (assets * totalShares) / poolAssets;
    }

    function previewWithdraw(uint256 shares) public view returns (uint256 assets) {
        if (totalShares == 0) return 0;
        return (shares * poolAssets) / totalShares;
    }

    // ----------------------------------------------------------------------------------------------------------
    // Internals
    // ----------------------------------------------------------------------------------------------------------

    function _settle(
        uint256 positionId,
        Position memory position,
        SettleReason reason
    ) private returns (uint256 payout, uint256 settlerReward) {
        Config memory cfg = config;
        uint256 exitPrice = _withSpread(_markPrice(_markets[position.marketId]), cfg.spreadBps, !position.isLong);
        payout = _payoutAt(position, exitPrice);

        if (reason == SettleReason.Liquidated) {
            if (!_isLiquidatable(position, payout, cfg.liquidationThresholdBps)) revert NotLiquidatable();
            settlerReward = (position.margin * cfg.liquidatorRewardBps) / BPS;
            payout = payout > settlerReward ? payout - settlerReward : 0;
        } else if (reason == SettleReason.Expired) {
            if (block.timestamp < position.expiresAt) revert NotExpired();
        }

        reservedAssets -= position.reserved;
        totalMargin -= position.margin;
        poolAssets = poolAssets + position.margin - payout - settlerReward;
        _removeOpenId(position.owner, positionId);
        delete _positions[positionId];

        _pay(position.owner, payout);
        _pay(msg.sender, settlerReward);
        _releaseSettleDeposit(position);

        emit PositionSettled(
            positionId,
            position.owner,
            reason,
            exitPrice,
            int256(payout) - int256(position.margin),
            payout,
            msg.sender,
            settlerReward
        );
    }

    /// @dev Validates an open request against the market and prices it. Charges the open fee and reserves
    ///      liquidity as a side effect, so it must only run inside `openPosition`.
    function _newPosition(
        uint256 marketId,
        bool isLong,
        uint256 collateralAmount,
        uint256 leverage,
        uint256 duration,
        uint256 acceptablePrice,
        Config memory cfg
    ) private returns (Position memory) {
        Market storage market = _market(marketId);

        if (!market.openEnabled) revert MarketClosed(marketId);
        if (leverage == 0 || leverage > market.maxLeverage) revert InvalidLeverage();
        if (duration < cfg.minDuration || duration > cfg.maxDuration) revert InvalidDuration();
        if (collateralAmount < cfg.minCollateral) revert CollateralTooSmall();

        uint256 entryPrice = _withSpread(_markPrice(market), cfg.spreadBps, isLong);
        if (isLong ? entryPrice > acceptablePrice : entryPrice < acceptablePrice) {
            revert PriceNotAcceptable(entryPrice);
        }

        (uint256 margin, uint256 reserved) = _fundPosition(collateralAmount, leverage, cfg);
        return
            Position({
                owner: msg.sender,
                marketId: uint32(marketId),
                isLong: isLong,
                openedAt: uint64(block.timestamp),
                expiresAt: uint64(block.timestamp + duration),
                margin: margin,
                size: margin * leverage,
                reserved: reserved,
                entryPrice: entryPrice,
                schedule: address(0),
                settleDeposit: 0
            });
    }

    /// @dev Charges the open fee to the pool and reserves the position's profit cap from free liquidity.
    function _fundPosition(
        uint256 collateralAmount,
        uint256 leverage,
        Config memory cfg
    ) private returns (uint256 margin, uint256 reserved) {
        uint256 fee = (collateralAmount * leverage * cfg.openFeeBps) / BPS;
        if (fee >= collateralAmount) revert CollateralTooSmall();
        margin = collateralAmount - fee;
        reserved = margin * cfg.maxProfitMultiple;

        poolAssets += fee;
        if (reserved > freeLiquidity()) revert InsufficientLiquidity();
        reservedAssets += reserved;
        totalMargin += margin;
    }

    /// @dev Books a scheduled `settleExpired` call. Scheduling is best effort: when the network has no room at
    ///      the expiry second, or the Schedule Service declines, the position still opens, the fee is not
    ///      charged, and anyone can settle it by hand after expiry.
    ///
    ///      The one hard failure is gas. `scheduleCall` burns all the gas it is given when that is too little,
    ///      which would take the whole transaction down with an opaque error. So the engine forwards a fixed
    ///      amount and reverts early, with the number, when the transaction cannot afford it.
    function _prepaySettlement(
        uint256 positionId,
        uint256 expiresAt,
        bool autoSettle,
        Config memory cfg
    ) private returns (address schedule, uint256 settleDeposit) {
        if (!autoSettle) return (address(0), 0);
        if (msg.value < cfg.autoSettleFee) revert AutoSettleFeeTooLow(cfg.autoSettleFee);

        uint256 settleAt = expiresAt + SETTLE_DELAY;
        if (cfg.autoSettleGasLimit != 0 && _hasScheduleCapacity(settleAt, cfg.autoSettleGasLimit)) {
            uint256 required = uint256(cfg.scheduleCallGas) + GAS_RESERVED_AFTER_SCHEDULING;
            if (gasleft() < required) revert AutoSettleNeedsMoreGas(required);

            schedule = _bookSettlement(positionId, settleAt, cfg.autoSettleGasLimit, cfg.scheduleCallGas);
            if (schedule != address(0)) return (schedule, cfg.autoSettleFee);
        }
        emit AutoSettleSkipped(positionId);
    }

    /// @dev Asks the Schedule Service to call `settleExpired(positionId)` at `settleAt`. Returns the schedule
    ///      address, or zero when the service declines.
    function _bookSettlement(
        uint256 positionId,
        uint256 settleAt,
        uint256 settleGasLimit,
        uint256 bookingGas
    ) private returns (address) {
        bytes memory booking = abi.encodeCall(
            IHederaScheduleService.scheduleCall,
            (address(this), settleAt, settleGasLimit, 0, abi.encodeCall(this.settleExpired, (positionId)))
        );
        (bool ok, bytes memory ret) = HSS.call{ gas: bookingGas }(booking);
        if (!ok || ret.length != 64) return address(0);

        (int64 responseCode, address created) = abi.decode(ret, (int64, address));
        return responseCode == HEDERA_SUCCESS ? created : address(0);
    }

    /// @dev Whether the network can take a scheduled call of `gasLimit` at `expirySecond`. False when there is
    ///      no Schedule Service at all, as on a local chain.
    function _hasScheduleCapacity(uint256 expirySecond, uint256 gasLimit) private view returns (bool) {
        (bool ok, bytes memory ret) = HSS.staticcall{ gas: SCHEDULE_CAPACITY_GAS }(
            abi.encodeCall(IHederaScheduleService.hasScheduleCapacity, (expirySecond, gasLimit))
        );
        return ok && ret.length == 32 && abi.decode(ret, (bool));
    }

    /// @dev When a position settles before its schedule runs, cancel the schedule and return the prepaid fee.
    ///      If the schedule cannot be cancelled the fee stays in the engine to pay for its execution.
    function _releaseSettleDeposit(Position memory position) private {
        if (position.schedule == address(0) || block.timestamp >= position.expiresAt) return;

        (bool ok, bytes memory ret) = HSS.call{ gas: DELETE_SCHEDULE_GAS }(
            abi.encodeCall(IHederaScheduleService.deleteSchedule, (position.schedule))
        );
        if (ok && ret.length == 32 && abi.decode(ret, (int64)) == HEDERA_SUCCESS) {
            _sendNative(position.owner, position.settleDeposit, false);
        }
    }

    /// @dev Delivers collateral, or credits it to `claimable` when the transfer fails. A settlement must never
    ///      depend on the recipient being able to receive: on Hedera an account that dissociates from the token
    ///      would otherwise make its own position impossible to liquidate.
    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;

        (bool ok, bytes memory ret) = address(collateral).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (ok && (ret.length == 0 || (ret.length == 32 && abi.decode(ret, (bool))))) return;

        claimable[to] += amount;
        totalClaimable += amount;
        emit PayoutDeferred(to, amount);
    }

    function _sendNative(address to, uint256 amount, bool required) private {
        if (amount == 0) return;
        (bool ok, ) = to.call{ value: amount }("");
        if (!ok && required) revert NativeTransferFailed();
    }

    function _removeOpenId(address owner_, uint256 positionId) private {
        uint256[] storage ids = _openIds[owner_];
        uint256 index = _openIdIndex[positionId];
        uint256 lastId = ids[ids.length - 1];

        ids[index] = lastId;
        _openIdIndex[lastId] = index;
        ids.pop();
        delete _openIdIndex[positionId];
    }

    function _markPrice(Market storage market) private view returns (uint256 price) {
        price = OracleLib.readChainlink(market.feed, market.feedDecimals, market.maxPriceAge);

        OracleGuard memory guard = oracleGuard;
        if (market.crossCheck && address(guard.supra) != address(0)) {
            (uint256 secondary, uint256 updatedAt) = OracleLib.readSupra(guard.supra, market.supraPairIndex);
            if (secondary != 0 && OracleLib.age(updatedAt) <= guard.supraMaxAge) {
                OracleLib.requireWithinDeviation(price, secondary, guard.maxDeviationBps);
            }
        }
    }

    function _market(uint256 marketId) private view returns (Market storage) {
        if (marketId >= _markets.length) revert MarketNotFound(marketId);
        return _markets[marketId];
    }

    function _position(uint256 positionId) private view returns (Position memory position) {
        position = _positions[positionId];
        if (position.owner == address(0)) revert PositionNotFound(positionId);
    }

    /// @dev Collateral a position is worth at `exitPrice`: margin plus PnL, floored at zero and capped at
    ///      margin plus the liquidity reserved for it.
    function _payoutAt(Position memory position, uint256 exitPrice) private pure returns (uint256) {
        int256 priceDelta = int256(exitPrice) - int256(position.entryPrice);
        if (!position.isLong) priceDelta = -priceDelta;

        int256 equity = int256(position.margin) + (int256(position.size) * priceDelta) / int256(position.entryPrice);
        if (equity <= 0) return 0;

        uint256 cap = position.margin + position.reserved;
        return uint256(equity) > cap ? cap : uint256(equity);
    }

    function _isLiquidatable(
        Position memory position,
        uint256 payout,
        uint256 liquidationThresholdBps
    ) private pure returns (bool) {
        return payout * BPS <= position.margin * liquidationThresholdBps;
    }

    /// @dev Moves `price` against the trader: up for a long entry or a short exit, down otherwise.
    function _withSpread(uint256 price, uint256 spreadBps, bool up) private pure returns (uint256) {
        return (price * (up ? BPS + spreadBps : BPS - spreadBps)) / BPS;
    }
}
