// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { AggregatorV3Interface } from "../interfaces/AggregatorV3Interface.sol";

/// @notice Chainlink Data Feed stand-in for local chains and tests. Anyone can set the price.
contract MockAggregator is AggregatorV3Interface {
    uint8 public immutable override decimals;
    string public override description;
    uint256 public constant override version = 1;

    uint80 private _roundId;
    int256 private _answer;
    uint256 private _updatedAt;

    constructor(uint8 decimals_, string memory description_, int256 answer_) {
        decimals = decimals_;
        description = description_;
        setAnswer(answer_);
    }

    /// @notice Publishes a new round stamped with the current block time.
    function setAnswer(int256 answer_) public {
        _roundId++;
        _answer = answer_;
        _updatedAt = block.timestamp;
    }

    /// @notice Rewrites the timestamp of the latest round, to simulate a stale feed.
    function setUpdatedAt(uint256 updatedAt_) external {
        _updatedAt = updatedAt_;
    }

    function getRoundData(uint80) external view override returns (uint80, int256, uint256, uint256, uint80) {
        return latestRoundData();
    }

    function latestRoundData() public view override returns (uint80, int256, uint256, uint256, uint80) {
        return (_roundId, _answer, _updatedAt, _updatedAt, _roundId);
    }
}
