// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { AggregatorV3Interface } from "../interfaces/AggregatorV3Interface.sol";
import { ISupraSValueFeed } from "../interfaces/ISupraSValueFeed.sol";

/// @title OracleLib
/// @notice Reads Chainlink and Supra prices and normalises them to 18 decimals.
library OracleLib {
    uint256 internal constant PRICE_DECIMALS = 18;
    uint256 internal constant BPS = 10_000;

    error InvalidOraclePrice();
    error StaleOraclePrice(uint256 updatedAt, uint256 maxAge);
    error OracleDeviationTooHigh(uint256 primaryPrice, uint256 secondaryPrice);

    /// @notice Latest Chainlink answer, scaled to 18 decimals.
    /// @dev Reverts when the answer is not positive or the round is older than `maxAge` seconds.
    function readChainlink(
        AggregatorV3Interface feed,
        uint8 feedDecimals,
        uint256 maxAge
    ) internal view returns (uint256 price) {
        (, int256 answer, , uint256 updatedAt, ) = feed.latestRoundData();
        if (answer <= 0) revert InvalidOraclePrice();
        if (age(updatedAt) > maxAge) revert StaleOraclePrice(updatedAt, maxAge);
        price = scale(uint256(answer), feedDecimals);
    }

    /// @notice Latest Supra value, scaled to 18 decimals, with its update time in seconds.
    /// @dev Never reverts: a failing or empty feed returns a zero price so callers can skip the cross-check.
    function readSupra(
        ISupraSValueFeed supra,
        uint256 pairIndex
    ) internal view returns (uint256 price, uint256 updatedAt) {
        try supra.getSvalue(pairIndex) returns (ISupraSValueFeed.PriceFeed memory feed) {
            if (feed.price == 0 || feed.decimals > 36) return (0, 0);
            price = scale(feed.price, feed.decimals);
            updatedAt = feed.time / 1000; // Supra reports milliseconds
        } catch {
            return (0, 0);
        }
    }

    /// @notice Reverts when `secondary` differs from `primary` by more than `maxDeviationBps`.
    function requireWithinDeviation(uint256 primary, uint256 secondary, uint256 maxDeviationBps) internal pure {
        uint256 diff = primary > secondary ? primary - secondary : secondary - primary;
        if (diff * BPS > primary * maxDeviationBps) revert OracleDeviationTooHigh(primary, secondary);
    }

    /// @notice Seconds since `updatedAt`. A timestamp ahead of the block counts as fresh.
    function age(uint256 updatedAt) internal view returns (uint256) {
        return block.timestamp > updatedAt ? block.timestamp - updatedAt : 0;
    }

    /// @notice Rescales `value` from `decimals` to 18 decimals.
    function scale(uint256 value, uint256 decimals) internal pure returns (uint256) {
        if (decimals == PRICE_DECIMALS) return value;
        if (decimals < PRICE_DECIMALS) return value * 10 ** (PRICE_DECIMALS - decimals);
        return value / 10 ** (decimals - PRICE_DECIMALS);
    }
}
