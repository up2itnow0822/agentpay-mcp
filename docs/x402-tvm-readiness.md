# x402 TVM exact-payment readiness

x402 Foundation PR #1944 is adding Python exact-payment support for TVM and TON-style flows. AgentPay MCP treats that as a watch signal, not as production support.

AgentPay MCP currently signs x402 exact payments only on the configured Base network. If a paid endpoint returns a TVM requirement such as `network: "tvm:-3"`, AgentPay MCP fails closed. It does not coerce the payment to Base, it does not attempt a best-effort jetton transfer, and it returns guidance that TVM support must be added deliberately before signing.

## Support matrix

| Rail | AgentPay MCP status | Current behavior |
|------|---------------------|------------------|
| Base EVM exact payment | Supported | `x402_pay` signs only the configured Base network, applies per-call caps, and records payment details. |
| Base Sepolia exact payment | Supported for test flows | Same signing path as Base mainnet when `CHAIN_ID=84532`. |
| Other EVM x402 networks | Watch state | The SDK baseline can see more chains, but AgentPay MCP restricts signing to the configured Base network until each chain has explicit wallet, asset, and audit support. |
| Solana x402 | Watch state | No AgentPay signing path is enabled. Requests must fail closed until a Solana wallet, token, receipt, and spend-policy path exists. |
| x402 batch settlement | Documentation and audit recipe | Batch deposit, voucher, refund, claim, recovery, and multi-SDK parity requirements are documented in `x402-batch-settlement-channels.md` and `x402-multi-sdk-batch-settlement-parity.md`. |
| TVM/TON exact payment | Watch state | Unsupported TVM requirements fail closed with guidance. No TVM signing, account deployment, faucet, gas, jetton, or facilitator settlement path is enabled. |

## Fail-closed invariant

AgentPay MCP must never silently treat an unsupported x402 network as compatible.

Required behavior:

1. Restrict `createX402Client` to the configured AgentPay network instead of accepting the SDK default network list.
2. Return an error when a `402 Payment Required` response has only unsupported payment options.
3. Include the offered network list and the supported AgentPay network list in the error.
4. For TVM/TON offers, say that TVM is watch-only until signing, account deployment, gas, jettons, settlement, and audit rows are implemented.
5. Do not call wallet signing or token transfer code for unsupported networks.

## Current implementation proof

The `x402_pay` tool now passes `supportedNetworks` to the x402 client based on `CHAIN_ID`:

- `CHAIN_ID=8453` allows only `base:8453`.
- `CHAIN_ID=84532` allows only `base-sepolia:84532`.
- `CHAIN_ID=tvm:-3` is rejected during config load with TVM-specific fail-closed guidance.

If a server returns HTTP 402 with only `tvm:-3`, the tool returns `Unsupported x402 Payment Requirement - Failed Closed` and includes the offered network.

## What must ship before TVM support turns on

TVM support should not be enabled by adding a string to a network list. It needs a complete payment path:

- TVM signer support with local key handling.
- Account deployment and funding checks.
- Gas and faucet handling for test networks.
- Jetton asset mapping and decimals.
- Facilitator verification and settlement-cache handling.
- Spend-policy checks before signing.
- Audit rows that record network, asset, amount, payee, facilitator, settlement result, and receipt.
- Tests for accept, decline, cap exceeded, bad asset, bad payee, settlement failure, and retry behavior.

Until those exist, TVM exact-payment requests stay blocked by design.
