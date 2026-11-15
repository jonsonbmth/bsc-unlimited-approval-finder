# BSC Unlimited Approval Finder

Finds **unlimited ERC-20 approvals** (`allowance == 2^256 - 1`) on a BSC wallet and
quantifies the exposure: the token balance the spender could drain **right now**.

## The problem

On BSC, the standard way to use a DEX or a DeFi app is to `approve()` a spender
contract once — and most front-ends ask for an **unlimited** allowance, because it
is one transaction instead of one per trade. One approval then puts the wallet's
**entire balance** of that token at risk. If the spender contract is ever
exploited, upgraded maliciously, or was a scam in the first place, the attacker
can drain the whole balance without any further signature from the owner.

People forget these approvals exist. This agent finds them and prices the risk.

## What it does

```
node finder.mjs <wallet-address> [--out report.json] [--from-block N]
```

1. **Validates its own lists live.** Every token in the built-in list must answer
   `symbol()` / `decimals()` as an ERC-20, and every spender must have code on
   chain. Anything that fails is dropped and reported as skipped — a typo in the
   list can never produce a finding.
2. **Reads live allowances.** For every token × spender pair it calls
   `allowance(owner, spender)` via public BSC RPC (batched, with endpoint
   rotation and rate-limit backoff). No indexer, no API key.
3. **Isolates unlimited approvals.** `allowance == 2^256 - 1` is the only thing
   that counts as "unlimited". Anything else that is nonzero is reported
   separately as a limited approval.
4. **Prices the exposure.** For each unlimited approval it reads the wallet's
   live `balanceOf` (what the spender could take today) and looks up the token's
   USD price on the public CoinGecko feed. If the price feed is down, the
   exposure is still listed in tokens and marked price-unknown.
5. **Finds the grant.** For each unlimited approval it searches the token's
   `Approval` events (address-scoped, so public RPCs accept it) for the
   transaction that granted it.
6. **Emits revoke calldata.** For each finding it prints the
   `approve(spender, 0)` calldata for that token — data only. **This tool never
   sends a transaction.** You revoke from your own wallet when ready.

Output is a JSON report on stdout (or `--out report.json`) plus a short
human-readable summary on stderr.

## Sample run

```
$ node finder.mjs 0xb976CC08C25a12C0a337c70EAD995483c4e567B0 --out sample-report.json
BSC Unlimited Approval Finder — 0xb976cc08c25a12c0a337c70ead995483c4e567b0
Scanned 40 token x spender pairs at block 133633999 (10 tokens, 4 spenders).
No unlimited approvals found in the scanned set.
Limited (nonzero, capped) approvals seen: 0.
```

The full report is in [`sample-report.json`](sample-report.json). That wallet had
**zero** allowances at all in the scanned set — no unlimited approvals, no limited
ones either. That is a real result, not a failure to read the chain: the
allowance-reading path was verified independently against live RPC (real zero
allowances, and real balances — the same code reads this wallet's 303 A404).

## Coverage

- **Tokens (10):** WBNB, USDT, USDC, BUSD, CAKE, BTCB, ETH, DOT, DOGE, LINK.
- **Spenders (4):** PancakeSwap V2 Router, PancakeSwap V3 SwapRouter, 1inch v5
  Router, Uniswap V3 SwapRouter (BSC). All validated live (must have code).
- **40 token × spender pairs** checked per run.

## Limitations (honest)

- **Curated set, not the whole chain.** An approval to a token or spender
  outside the built-in lists is not found. This is a deliberate trade-off:
  free public BSC RPCs refuse unfiltered `eth_getLogs` (tested: bsc-dataseed,
  bsc.publicnode, Ankr, 1RPC all reject or rate-limit log scans without an
  `address` filter), and there is no free no-key indexer. The alternative —
  requiring a BscScan API key — would make the tool unusable for most people.
  The lists cover the tokens and routers a normal BSC wallet actually uses.
- **Prices are best-effort.** CoinGecko's public feed can be down or
  rate-limited; then exposure is token-denominated only.
- **Grant lookup is bounded.** The Approval-event search starts 90 days back
  by default (`--from-block` overrides). An approval granted earlier is still
  found by the live `allowance()` check — only its grant transaction is missing.
- **It finds approvals, not intent.** An unlimited approval to a reputable
  router you still use is normal. The report ranks by exposure so you can
  decide what to revoke; it does not tell you to revoke everything.

## Requirements

- Node.js 20+ (uses built-in `fetch`; Node 24 honours proxy env vars).
- Internet access to public BSC RPCs and (optionally) CoinGecko.
- No private key, no signing, no transactions. Ever.

## License

MIT — see [LICENSE](LICENSE).
