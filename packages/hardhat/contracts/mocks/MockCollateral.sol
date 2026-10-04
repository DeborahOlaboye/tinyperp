// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Collateral stand-in for unit tests. Behaves like an HTS token seen through its ERC-20 facade:
///         6 decimals, HIP-719 association, and transfers that fail for accounts that are not associated.
contract MockCollateral is ERC20 {
    uint256 internal constant SUCCESS = 22;
    uint256 internal constant TOKEN_ALREADY_ASSOCIATED = 194;

    bool public enforceAssociation;
    mapping(address account => bool) public associated;

    error TokenNotAssociated(address account);

    constructor() ERC20("Mock USD", "mUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function associate() external returns (uint256 responseCode) {
        if (associated[msg.sender]) return TOKEN_ALREADY_ASSOCIATED;
        associated[msg.sender] = true;
        return SUCCESS;
    }

    function dissociate() external returns (uint256 responseCode) {
        associated[msg.sender] = false;
        return SUCCESS;
    }

    /// @notice When on, transfers to an account that has not associated revert, as they do on Hedera.
    function setEnforceAssociation(bool enforce) external {
        enforceAssociation = enforce;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (enforceAssociation && to != address(0) && !associated[to]) revert TokenNotAssociated(to);
        super._update(from, to, value);
    }
}
