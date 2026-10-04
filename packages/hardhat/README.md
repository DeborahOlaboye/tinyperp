# Hardhat package (Hedera)

The Tinyperp contracts, deploy scripts, tests and HashScan verification. The [root README](../../README.md) explains how the engine works; this file covers running this package.

## Local development

From the repo root, use the explicit `hardhat:*` scripts for this package. Inside `packages/hardhat`, use the unprefixed package-local scripts.

1. **Start the local chain** (terminal 1, from repo root):
   ```bash
   yarn hardhat:chain
   ```
   This starts `hardhat node` with **Hedera testnet forking** (`HEDERA_FORKING=true` and `@hashgraph/system-contracts-forking`). JSON-RPC is served at **http://127.0.0.1:8545**.

2. **Deploy to the running fork** (terminal 2):
   ```bash
   yarn hardhat:deploy --network localhost
   ```
   This deploys `TestUSD` (which creates the tUSD HTS token), `PerpEngine`, mock Chainlink and Supra feeds, lists three markets and seeds the pool. Use **`localhost`** so Hardhat connects to the long-running node on port 8545.

   **`yarn hardhat:deploy` without `--network localhost`** uses the default network `hardhat`, which is the **in-process ephemeral** Hardhat network—**not** the same process as `yarn hardhat:chain`. For deploys against the forked node you started in step 1, always pass **`--network localhost`** while that node is running.

3. **Move a mock price** to see positions gain and lose:
   ```bash
   yarn hardhat:set-price --market HBAR/USD --price 0.12
   ```

4. **Run contract tests** (from repo root; tests use `HEDERA_FORKING=true` and can run against the fork or standalone):
   ```bash
   yarn hardhat:test
   ```

## Deploy and verify on Hedera testnet/mainnet

You need a deployer account with HBAR on the target network. Without funds, deploy and verify will fail with "Sender account not found".

1. **Generate or import an account** (from the repo root):
   ```bash
   yarn hardhat:account:generate
   ```
   or
   ```bash
   yarn hardhat:account:import
   ```
   The encrypted key is stored in `packages/hardhat/.env`.

2. **Fund the account on testnet:**  
   Use the [Hedera Portal faucet](https://portal.hedera.com/faucet) to receive testnet HBAR.

3. **Deploy to Hedera testnet** (from repo root):
   ```bash
   yarn hardhat:deploy --network hederaTestnet
   ```
   You will be prompted to enter the password to decrypt your deployer key. On testnet the engine uses the live Chainlink Data Feeds and the Supra push oracle; addresses are in `utils/tinyperpConfig.ts`.

4. **Run the smoke test.** It opens and closes a position, then opens one that the Schedule Service settles, and prints a HashScan link per step:
   ```bash
   yarn hardhat:smoke --network hederaTestnet
   ```

5. **Verify on Sourcify** (shows as verified on HashScan). Uses the solc standard-json from `artifacts/build-info` and submits directly to the Sourcify API v2 — `@nomicfoundation/hardhat-verify` is not used because its Hardhat 2-compatible line only speaks the removed Sourcify API v1:
   ```bash
   yarn hardhat:verify -- PerpEngine testnet                          # address from deployments/hederaTestnet/
   yarn hardhat:verify -- PerpEngine testnet 0xYourContractAddress    # explicit address
   ```
   Use `mainnet` instead of `testnet` for chain 295.

## Layout

- `contracts/` — `PerpEngine.sol`, `TestUSD.sol`, `libraries/OracleLib.sol`, `interfaces/`, `mocks/`
- `deploy/` — hardhat-deploy scripts: `00` TestUSD, `01` PerpEngine, `02` markets and pool seed, `99` smoke test
- `utils/tinyperpConfig.ts` — engine parameters, oracle addresses and markets, per network
- `scripts/` — generateAccount, importAccount, verifySourcify.ts, etc.
- `test/` — contract tests
- `hardhat.config.ts` — networks (`hardhat`, `localhost` for RPC at 127.0.0.1:8545, `hederaTestnet`, `hederaMainnet`)

Network and RPC URLs are in `hardhat.config.ts`. Deployer key is read from `.env` (encrypted) and decrypted at deploy time for live networks.
