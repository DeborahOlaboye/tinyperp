// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { IHederaScheduleService } from "../interfaces/IHederaScheduleService.sol";

/// @notice Schedule Service stand-in. Tests install its code at 0x16b, so it keeps no constructor state.
contract MockScheduleService is IHederaScheduleService {
    int64 internal constant SUCCESS = 22;
    int64 internal constant INVALID_SCHEDULE_ID = 201;

    struct ScheduledCall {
        address to;
        uint256 expirySecond;
        uint256 gasLimit;
        bytes callData;
        bool deleted;
    }

    uint160 public scheduleCount;
    bool public rejectSchedules;
    bool public rejectDeletes;
    bool public noCapacity;
    mapping(address schedule => ScheduledCall) public scheduled;

    function setRejectSchedules(bool reject) external {
        rejectSchedules = reject;
    }

    function setRejectDeletes(bool reject) external {
        rejectDeletes = reject;
    }

    function setNoCapacity(bool none) external {
        noCapacity = none;
    }

    function scheduleCall(
        address to,
        uint256 expirySecond,
        uint256 gasLimit,
        uint64,
        bytes memory callData
    ) external override returns (int64 responseCode, address scheduleAddress) {
        if (rejectSchedules) return (INVALID_SCHEDULE_ID, address(0));

        scheduleAddress = address(uint160(0x5000) + ++scheduleCount);
        scheduled[scheduleAddress] = ScheduledCall(to, expirySecond, gasLimit, callData, false);
        return (SUCCESS, scheduleAddress);
    }

    function hasScheduleCapacity(uint256, uint256) external view override returns (bool) {
        return !noCapacity;
    }

    function deleteSchedule(address scheduleAddress) external override returns (int64 responseCode) {
        if (rejectDeletes || scheduled[scheduleAddress].to == address(0)) return INVALID_SCHEDULE_ID;
        scheduled[scheduleAddress].deleted = true;
        return SUCCESS;
    }

    /// @notice Runs a scheduled call the way the network would at `expirySecond`.
    function execute(address scheduleAddress) external returns (bool ok, bytes memory result) {
        ScheduledCall memory call_ = scheduled[scheduleAddress];
        require(call_.to != address(0) && !call_.deleted, "schedule not pending");
        return call_.to.call{ gas: call_.gasLimit }(call_.callData);
    }
}
