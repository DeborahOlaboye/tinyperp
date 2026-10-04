// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IHederaScheduleService
/// @notice Minimal interface of the Hedera Schedule Service system contract at 0x16b (HIP-1215).
/// @dev A contract that calls `scheduleCall` is the payer of the scheduled execution, so it must hold enough
///      HBAR to cover `gasLimit` at the time the network runs the call.
interface IHederaScheduleService {
    /// @param to Contract the network will call.
    /// @param expirySecond Consensus second at which the call executes.
    /// @param gasLimit Gas limit of the scheduled call.
    /// @param value HBAR, in tinybars, sent with the scheduled call.
    /// @param callData ABI-encoded call.
    /// @return responseCode 22 on success.
    /// @return scheduleAddress Address of the created schedule, zero on failure.
    function scheduleCall(
        address to,
        uint256 expirySecond,
        uint256 gasLimit,
        uint64 value,
        bytes memory callData
    ) external returns (int64 responseCode, address scheduleAddress);

    /// @notice Whether the network can still accept a call of `gasLimit` in `expirySecond`.
    function hasScheduleCapacity(uint256 expirySecond, uint256 gasLimit) external view returns (bool hasCapacity);

    /// @notice Deletes a schedule that has not executed yet.
    function deleteSchedule(address scheduleAddress) external returns (int64 responseCode);
}
