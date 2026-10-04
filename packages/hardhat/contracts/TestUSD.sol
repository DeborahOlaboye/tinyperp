// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

import { IHederaTokenService } from "./interfaces/IHederaTokenService.sol";

/// @title TestUSD
/// @notice Creates the HTS collateral token used on testnet and hands it out through a faucet.
/// @dev This contract is the token's treasury and holds its supply key, so only it can mint. On mainnet you
///      would point the engine at an existing HTS stablecoin instead and not deploy this.
contract TestUSD is Ownable {
    address internal constant HTS = address(0x167);
    int64 internal constant SUCCESS = 22;
    uint256 internal constant SUPPLY_KEY = 16;
    int64 internal constant AUTO_RENEW_PERIOD = 7_776_000; // 90 days

    int32 public constant DECIMALS = 6;

    /// @notice Amount `drip` sends, in the token's smallest unit.
    uint256 public immutable dripAmount;
    /// @notice Seconds an account waits between drips.
    uint256 public immutable dripCooldown;

    /// @notice The HTS token, zero until `createToken` has run.
    address public token;
    mapping(address account => uint256 timestamp) public nextDripAt;

    event TokenCreated(address indexed token, string name, string symbol);
    event Dripped(address indexed to, uint256 amount);

    error ZeroAddress();
    error TokenAlreadyCreated();
    error TokenNotCreated();
    error AmountTooLarge();
    error DripOnCooldown(uint256 availableAt);
    error HtsCreateFailed(int64 responseCode);
    error HtsMintFailed(int64 responseCode);
    error HtsTransferFailed(int64 responseCode);
    error NativeTransferFailed();

    constructor(address owner_, uint256 dripAmount_, uint256 dripCooldown_) Ownable(owner_) {
        dripAmount = dripAmount_;
        dripCooldown = dripCooldown_;
    }

    /// @notice Accepts the HBAR the Token Service returns when the creation fee is overpaid.
    receive() external payable {}

    /// @notice Creates the token. `msg.value` pays the HTS creation fee.
    function createToken(
        string calldata name,
        string calldata symbol
    ) external payable onlyOwner returns (address created) {
        if (token != address(0)) revert TokenAlreadyCreated();

        IHederaTokenService.TokenKey[] memory keys = new IHederaTokenService.TokenKey[](1);
        keys[0] = IHederaTokenService.TokenKey({
            keyType: SUPPLY_KEY,
            key: IHederaTokenService.KeyValue({
                inheritAccountKey: false,
                contractId: address(this),
                ed25519: "",
                ECDSA_secp256k1: "",
                delegatableContractId: address(0)
            })
        });

        int64 responseCode;
        (responseCode, created) = IHederaTokenService(HTS).createFungibleToken{ value: msg.value }(
            IHederaTokenService.HederaToken({
                name: name,
                symbol: symbol,
                treasury: address(this),
                memo: "",
                tokenSupplyType: false,
                maxSupply: 0,
                freezeDefault: false,
                tokenKeys: keys,
                expiry: IHederaTokenService.Expiry({
                    second: 0,
                    autoRenewAccount: address(this),
                    autoRenewPeriod: AUTO_RENEW_PERIOD
                })
            }),
            0,
            DECIMALS
        );
        if (responseCode != SUCCESS) revert HtsCreateFailed(responseCode);

        token = created;
        emit TokenCreated(created, name, symbol);
    }

    /// @notice Sends `dripAmount` to the caller, once per `dripCooldown`.
    /// @dev The caller must be associated with the token or have a free auto-association slot.
    function drip() external {
        uint256 availableAt = nextDripAt[msg.sender];
        if (block.timestamp < availableAt) revert DripOnCooldown(availableAt);

        nextDripAt[msg.sender] = block.timestamp + dripCooldown;
        _mintTo(msg.sender, dripAmount);
        emit Dripped(msg.sender, dripAmount);
    }

    /// @notice Mints any amount to `to`. Used to seed the liquidity pool.
    function mintTo(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        _mintTo(to, amount);
    }

    /// @notice Withdraws HBAR left over from the creation fee.
    function sweepNative(address payable to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        (bool ok, ) = to.call{ value: address(this).balance }("");
        if (!ok) revert NativeTransferFailed();
    }

    function _mintTo(address to, uint256 amount) private {
        address token_ = token;
        if (token_ == address(0)) revert TokenNotCreated();
        if (amount > uint256(uint64(type(int64).max))) revert AmountTooLarge();
        int64 htsAmount = int64(uint64(amount));

        (int64 mintCode, , ) = IHederaTokenService(HTS).mintToken(token_, htsAmount, new bytes[](0));
        if (mintCode != SUCCESS) revert HtsMintFailed(mintCode);

        int64 transferCode = IHederaTokenService(HTS).transferToken(token_, address(this), to, htsAmount);
        if (transferCode != SUCCESS) revert HtsTransferFailed(transferCode);
    }
}
