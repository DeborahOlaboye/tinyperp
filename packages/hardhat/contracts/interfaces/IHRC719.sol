// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IHRC719
/// @notice Token association functions every HTS token exposes at its own address (HIP-719).
/// @dev Call these on the token address. The caller is the account that gets associated.
interface IHRC719 {
    /// @return responseCode 22 on success.
    function associate() external returns (uint256 responseCode);

    /// @return responseCode 22 on success.
    function dissociate() external returns (uint256 responseCode);
}
