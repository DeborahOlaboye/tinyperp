// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ISupraSValueFeed
/// @notice Read interface of the Supra push oracle (S-Value feed).
/// @dev Pair indexes: https://docs.supra.com/oracles/data-feeds/data-feeds-index
interface ISupraSValueFeed {
    /// @param round Supra round the value belongs to.
    /// @param decimals Decimals of `price`.
    /// @param time Unix time of the update, in milliseconds.
    /// @param price Price scaled by `decimals`.
    struct PriceFeed {
        uint256 round;
        uint256 decimals;
        uint256 time;
        uint256 price;
    }

    function getSvalue(uint256 pairIndex) external view returns (PriceFeed memory);
}
