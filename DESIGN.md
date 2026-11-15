# Design note: why unlimited approvals are the most dangerous allowance

## The pattern

ERC-20 `approve(spender, amount)` is a standing instruction: "this spender may
move up to `amount` of my tokens, whenever it wants, without asking me again."
Most DEX and DeFi front-ends request `amount = 2^256 - 1` — the maximum possible
value — because it turns an approval into a one-time cost. Approve once, trade
forever. The UI calls this "unlimited" and presents it as a convenience.

The danger is the asymmetry: **one signature, whole balance at risk.** A limited
approval caps the loss at the approved amount. An unlimited approval caps the
loss at the wallet's entire current and future balance of that token. The owner
does not get another prompt. The spender — or anyone who compromises the spender
— can drain everything in a single transaction.

This is not theoretical. Approval phishing and exploited spender contracts are
among the most common ways BSC wallets lose funds: the victim approved a router
or a "claim" contract once, months ago, and the drain happens later, silently,
with no new signature. The approval is the vulnerability; the exploit is just
the trigger.

## Why read-only is the right call

An agent that *fixes* approvals would need to sign revokes — which means holding
a key, or asking the user to sign inside the agent's flow. Both are worse than
the disease for a scanning tool:

- Holding a key turns the auditor into the thing it audits.
- A revoke is itself a transaction with a cost and a risk (wrong spender, wrong
  token, front-running on a big revocation is not a thing, but a mistaken
  `approve(spender, 0)` on a token you still use breaks your positions).

So this agent reads and reports. It hands you the exact calldata to revoke
(`approve(spender, 0)` for that token) and lets you send it from your own
wallet, where you can see the spender, the token, and the gas before you sign.
A scanner should never be able to move money. That is a design rule, not a
missing feature.

## Why a curated list, not a full-chain scan

The complete answer to "what has this wallet approved?" is "scan every
`Approval` event ever emitted with this wallet as owner." That needs either an
indexer (BscScan API key) or an `eth_getLogs` query with no address filter.
Free public BSC RPCs refuse the latter — tested during development against
bsc-dataseed, bsc.publicnode, Ankr and 1RPC: all reject or rate-limit
unfiltered log scans. Requiring an API key would make the tool unusable for
most people, so the agent instead checks live `allowance()` for a curated set
of the tokens and spenders a normal BSC wallet actually uses (10 tokens × 4
routers = 40 pairs), and validates every list entry live before trusting it.
The trade-off is stated in the report itself: approvals outside the set are not
covered. For the common case — a wallet that traded on PancakeSwap or 1inch —
the set is the whole story.

## What a zkVerify proof could add (future work, not implemented)

An audit report is a claim: "at block N, this wallet had these unlimited
approvals." Today you have to trust the agent that ran the scan. A zkVerify
proof could make that claim checkable without trusting the agent: the agent
would generate a proof that its decision followed a public rule ("allowance
equals 2^256-1, balance read at block N, price from feed F") and publish the
proof alongside the report, so anyone could verify the audit without re-running
it or trusting the auditor's machine. That is the honest next step for this
tool — a proof of a *reading*, not a proof of a *judgement*. It is not built
here: the scan, the ranking, and the revoke calldata are the deliverable, and
bolting on a proof circuit for a claim nobody asked to verify would be theatre.
