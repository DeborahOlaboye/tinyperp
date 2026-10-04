// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ISupraSValueFeed } from "../interfaces/ISupraSValueFeed.sol";

/// @notice Supra push oracle stand-in for local chains and tests.
contract MockSupraFeed is ISupraSValueFeed {
    mapping(uint256 pairIndex => PriceFeed) private _feeds;
    bool public broken;

    error FeedUnavailable();

    /// @notice Publishes an 18-decimal value stamped with the current block time.
    function setValue(uint256 pairIndex, uint256 price) external {
        setValueAt(pairIndex, price, block.timestamp);
    }

    /// @param updatedAt Unix time in seconds. Stored in milliseconds, as Supra reports it.
    function setValueAt(uint256 pairIndex, uint256 price, uint256 updatedAt) public {
        _feeds[pairIndex] = PriceFeed({ round: updatedAt * 1000, decimals: 18, time: updatedAt * 1000, price: price });
    }

    /// @notice Makes `getSvalue` revert, to simulate an unavailable feed.
    function setBroken(bool broken_) external {
        broken = broken_;
    }

    function getSvalue(uint256 pairIndex) external view override returns (PriceFeed memory) {
        if (broken) revert FeedUnavailable();
        return _feeds[pairIndex];
    }
}
