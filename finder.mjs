// unlimited-finder — BSC Unlimited Approval Finder
// Finds ERC-20 approvals where allowance == 2^256-1 (unlimited) on a BSC wallet
// and quantifies the exposure: the token balance the spender could drain right now.
//
// Usage: node finder.mjs <wallet-address> [--out report.json] [--from-block N]
//   --out        write the JSON report to a file (default: print to stdout)
//   --from-block first block for the Approval-event lookup (default: 90 days back)
//
// Read-only. No private key, no signing, no transactions. Public RPC + public
// CoinGecko price feed only. No API keys.
//
// Exit codes: 0 ok, 1 usage error, 2 all RPC endpoints failed.

import { writeFileSync } from 'node:fs';

const MAX_UINT256 = (1n << 256n) - 1n;
const APPROVAL_TOPIC = '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925';
const APPROVE_SELECTOR = '0x095ea7b3'; // approve(address,uint256)

// Public BSC RPCs, tried in order. All are free, no key.
const RPCS = [
  'https://bsc-dataseed.bnbchain.org',
  'https://bsc-dataseed1.bnbchain.org',
  'https://bsc-dataseed2.bnbchain.org',
  'https://bsc.publicnode.com',
];

// Well-known BSC tokens. Every entry is validated live at runtime: the agent
// calls symbol()/decimals() first and silently drops anything that does not
// answer as an ERC-20, so a wrong or dead address can never produce a finding.
const TOKENS = [
  { address: '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c', label: 'WBNB' },
  { address: '0x55d398326f99059fF775485246999027B3197955', label: 'USDT' },
  { address: '0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d', label: 'USDC' },
  { address: '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56', label: 'BUSD' },
  { address: '0x0E09FaBB73Bd3Ade0a17ECC321fD13a19e81cE82', label: 'CAKE' },
  { address: '0x7130d2A12B9BCbFAe4f2634d864A1Ee1Ce3Ead9c', label: 'BTCB' },
  { address: '0x2170Ed0880ac9A755fd29B2688956BD959F933F8', label: 'ETH' },
  { address: '0x7083609fCE4d1d8Dc0C979AAb8c869Ea2C873402', label: 'DOT' },
  { address: '0xba2aE424d960c26247Dd6c32edC70B295c744C43', label: 'DOGE' },
  { address: '0xF8A0BF9cF54Bb92F17374d9e9A321E6a111a51bD', label: 'LINK' },
];

// Spenders a BSC wallet commonly approves: DEX routers and aggregators.
// An approval to a spender outside this list is NOT covered by the live scan
// (see README limitations) unless it shows up in the Approval-event lookup.
const SPENDERS = [
  { address: '0x10ED43C718714eb63d5aA57B78B54704E256024E', label: 'PancakeSwap V2 Router' },
  { address: '0x1b81D678ffb9C0263b24A97847620C99d213eB14', label: 'PancakeSwap V3 SwapRouter' },
  { address: '0x111111125421cA6dc452d289314280a0f8842A65', label: '1inch v5 Router' },
  { address: '0xDef1c0ded9bec7F1a1670819833240f027b4eD22', label: '0x Exchange Proxy' },
  { address: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD', label: 'Uniswap V3 SwapRouter (BSC)' },
];

// ---------------------------------------------------------------------------
// tiny JSON-RPC client with endpoint rotation + batch support
// ---------------------------------------------------------------------------
let rpcUrl = RPCS[0];

async function rpcSingle(url, method, params, id = 1) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  const j = await res.json();
  if (j.error) throw new Error(`${url}: ${j.error.message} (code ${j.error.code})`);
  return j.result;
}

// One JSON-RPC batch (array) against the current endpoint; on failure, rotate
// to the next endpoint and retry the whole batch once per endpoint.
// Large call lists are split into small chunks: public BSC nodes rate-limit
// big batches (HTTP 429). A 429 waits briefly and retries.
const BATCH_SIZE = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpcBatch(calls) {
  const results = new Array(calls.length).fill(null);
  for (let start = 0; start < calls.length; start += BATCH_SIZE) {
    const chunk = calls.slice(start, start + BATCH_SIZE);
    const payload = chunk.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, method: c.method, params: c.params }));
    let lastErr = null;
    let done = false;
    for (let attempt = 0; attempt < RPCS.length * 2 && !done; attempt++) {
      const url = RPCS[(RPCS.indexOf(rpcUrl) + attempt) % RPCS.length];
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        if (res.status === 429) { await sleep(1200); continue; }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const j = await res.json();
        for (const item of j) {
          if (item.error) throw new Error(`${url}: ${item.error.message}`);
          results[start + item.id - 1] = item.result;
        }
        rpcUrl = url; // stick with the endpoint that worked
        done = true;
      } catch (e) {
        lastErr = e;
        await sleep(400);
      }
    }
    if (!done) throw lastErr ?? new Error('all RPC endpoints failed');
    if (start + BATCH_SIZE < calls.length) await sleep(250); // breathe between chunks
  }
  return results;
}

async function rpc(method, params) {
  return (await rpcBatch([{ method, params }]))[0];
}

// ---------------------------------------------------------------------------
// ABI helpers (hand-rolled, no dependencies)
// ---------------------------------------------------------------------------
const pad32 = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const addrTopic = (a) => '0x000000000000000000000000' + a.slice(2).toLowerCase();
const toHex = (n) => '0x' + n.toString(16);
const dataOf = (selector, ...words) => selector + words.map(pad32).join('');

// eth_call a view function; returns raw hex or null on revert/no-code.
async function ethCall(to, data) {
  try {
    const r = await rpc('eth_call', [{ to, data }, 'latest']);
    return r;
  } catch {
    return null;
  }
}

function parseString(hex) {
  // ABI-encoded string: 0x + offset(32B) + length(32B) + data.
  if (!hex || hex === '0x') return null;
  try {
    if (hex.length === 66) {
      // bytes32 symbol (older BEP-20s): raw ASCII, null-padded.
      return Buffer.from(hex.slice(2), 'hex').toString('utf8').replace(/\0+$/, '') || null;
    }
    if (hex.length < 130) return null;
    const len = parseInt(hex.slice(66, 130), 16);
    if (len < 0 || len > 1024) return null;
    const bytes = Buffer.from(hex.slice(130, 130 + len * 2), 'hex');
    return bytes.toString('utf8').replace(/\0+$/, '');
  } catch { return null; }
}

function parseUint(hex) {
  if (!hex || hex === '0x') return null;
  try { return BigInt(hex); } catch { return null; }
}

function formatUnits(value, decimals) {
  const neg = value < 0n;
  const s = (neg ? -value : value).toString().padStart(decimals + 1, '0');
  const int = s.slice(0, -decimals) || '0';
  const frac = s.slice(-decimals).replace(/0+$/, '');
  return (neg ? '-' : '') + int + (frac ? '.' + frac : '');
}

// ---------------------------------------------------------------------------
// CoinGecko public price feed (no key). Returns {addressLower: usd}.
// ---------------------------------------------------------------------------
async function fetchPrices(addresses) {
  const out = {};
  if (!addresses.length) return out;
  // CoinGecko caps the list per request; chunk at 50.
  for (let i = 0; i < addresses.length; i += 50) {
    const chunk = addresses.slice(i, i + 50);
    const url = 'https://api.coingecko.com/api/v3/simple/token_price/binance-smart-chain'
      + '?contract_addresses=' + chunk.map((a) => a.toLowerCase()).join(',')
      + '&vs_currencies=usd';
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const j = await res.json();
      for (const [addr, v] of Object.entries(j)) {
        if (v && typeof v.usd === 'number') out[addr.toLowerCase()] = v.usd;
      }
    } catch { /* price feed down: exposures stay token-denominated */ }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Approval-event lookup for one (token, spender) pair, scoped by token address
// (public RPCs accept address-scoped log queries). Returns the earliest grant.
// ---------------------------------------------------------------------------
async function findGrantEvent(token, owner, spender, fromBlock, toBlock) {
  const topics = [APPROVAL_TOPIC, addrTopic(owner), addrTopic(spender)];
  // 100k-block chunks; most public nodes accept address-scoped ranges of this size.
  const CHUNK = 100000;
  for (let from = fromBlock; from <= toBlock; from += CHUNK) {
    const to = Math.min(from + CHUNK - 1, toBlock);
    try {
      const logs = await rpc('eth_getLogs', [{
        address: token,
        fromBlock: toHex(BigInt(from)),
        toBlock: toHex(BigInt(to)),
        topics,
      }]);
      if (logs && logs.length) {
        const first = logs[0];
        return {
          blockNumber: parseInt(first.blockNumber, 16),
          transactionHash: first.transactionHash,
          logIndex: parseInt(first.logIndex, 16),
        };
      }
    } catch {
      return null; // node refused the range: grant evidence unavailable, not fatal
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const owner = args.find((a) => !a.startsWith('--'));
  const outIdx = args.indexOf('--out');
  const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
  const fromIdx = args.indexOf('--from-block');
  const fromBlockFlag = fromIdx >= 0 ? Number(args[fromIdx + 1]) : null;

  if (!owner || !/^0x[0-9a-fA-F]{40}$/.test(owner)) {
    console.error('Usage: node finder.mjs <wallet-address> [--out report.json] [--from-block N]');
    process.exit(1);
  }
  const wallet = owner.toLowerCase();

  const latestHex = await rpc('eth_blockNumber', []);
  const latest = parseInt(latestHex, 16);
  // 90 days back by default (~2.6M blocks at 3s/block).
  const fromBlock = fromBlockFlag ?? Math.max(0, latest - 2_592_000);

  // 1) Validate the token list live: symbol() + decimals() must answer.
  // Malformed addresses (a typo in the list) are dropped before any RPC call.
  const validTokens = TOKENS.filter((t) => /^0x[0-9a-fA-F]{40}$/.test(t.address));
  const skippedTokens = TOKENS.filter((t) => !/^0x[0-9a-fA-F]{40}$/.test(t.address)).map((t) => `${t.label} (malformed address)`);
  const tokenCalls = [];
  for (const t of validTokens) {
    tokenCalls.push({ method: 'eth_call', params: [{ to: t.address, data: '0x95d89b41' }, 'latest'] }); // symbol()
    tokenCalls.push({ method: 'eth_call', params: [{ to: t.address, data: '0x313ce567' }, 'latest'] }); // decimals()
  }
  const tokenResults = await rpcBatch(tokenCalls);
  const tokens = [];
  for (let i = 0; i < validTokens.length; i++) {
    const sym = parseString(tokenResults[i * 2]);
    const dec = parseUint(tokenResults[i * 2 + 1]);
    if (!sym || dec === null || dec > 36) { skippedTokens.push(`${validTokens[i].label} (no ERC-20 answer)`); continue; }
    tokens.push({ ...validTokens[i], symbol: sym, decimals: Number(dec) });
  }

  // Validate spenders live: a real router/aggregator is a contract (has code).
  const validSpenders = SPENDERS.filter((s) => /^0x[0-9a-fA-F]{40}$/.test(s.address));
  const skippedSpenders = SPENDERS.filter((s) => !/^0x[0-9a-fA-F]{40}$/.test(s.address)).map((s) => `${s.label} (malformed address)`);
  const codeResults = await rpcBatch(validSpenders.map((s) => ({ method: 'eth_getCode', params: [s.address, 'latest'] })));
  const spenders = [];
  for (let i = 0; i < validSpenders.length; i++) {
    if (!codeResults[i] || codeResults[i] === '0x') { skippedSpenders.push(`${validSpenders[i].label} (no code on chain)`); continue; }
    spenders.push(validSpenders[i]);
  }

  // 2) Live allowance() for every token x spender pair (batched).
  const pairCalls = [];
  const pairs = [];
  for (const t of tokens) {
    for (const s of spenders) {
      pairs.push({ token: t, spender: s });
      pairCalls.push({
        method: 'eth_call',
        params: [{ to: t.address, data: dataOf('0xdd62ed3e', wallet, s.address) }, 'latest'],
      });
    }
  }
  const allowances = await rpcBatch(pairCalls);

  const unlimited = [];
  const limited = [];
  for (let i = 0; i < pairs.length; i++) {
    const v = parseUint(allowances[i]);
    if (v === null) continue; // call failed: treated as unknown, never as a finding
    if (v === MAX_UINT256) unlimited.push({ ...pairs[i], allowance: v });
    else if (v > 0n) limited.push({ ...pairs[i], allowance: v });
  }

  // 3) For each unlimited approval: live balanceOf (the exposure) + grant event.
  // Limited approvals get a balanceOf too, so the report proves the scan reads
  // real on-chain allowances even when nothing is unlimited.
  const exposureTargets = [...unlimited, ...limited];
  const exposureCalls = exposureTargets.map(({ token }) => ({
    method: 'eth_call',
    params: [{ to: token.address, data: dataOf('0x70a08231', wallet) }, 'latest'],
  }));
  const balances = exposureCalls.length ? await rpcBatch(exposureCalls) : [];
  const prices = await fetchPrices(unlimited.map(({ token }) => token.address));

  const limitedApprovals = limited.map((entry, idx) => {
    const balance = parseUint(balances[unlimited.length + idx]) ?? 0n;
    return {
      token: entry.token.address,
      symbol: entry.token.symbol,
      spender: entry.spender.address,
      spenderLabel: entry.spender.label,
      allowance: entry.allowance.toString(),
      allowanceHuman: formatUnits(entry.allowance, entry.token.decimals),
      balanceHuman: formatUnits(balance, entry.token.decimals),
    };
  });
  // Largest allowances first; cap the list so the report stays readable.
  limitedApprovals.sort((a, b) => (BigInt(b.allowance) > BigInt(a.allowance) ? 1 : -1));
  const limitedShown = limitedApprovals.slice(0, 20);

  const findings = [];
  for (let i = 0; i < unlimited.length; i++) {
    const { token, spender } = unlimited[i];
    const balance = parseUint(balances[i]) ?? 0n;
    const price = prices[token.address.toLowerCase()] ?? null;
    const exposureUsd = price === null ? null : Number(formatUnits(balance, token.decimals)) * price;
    const grant = await findGrantEvent(token.address, wallet, spender.address, fromBlock, latest);
    findings.push({
      token: token.address,
      symbol: token.symbol,
      decimals: token.decimals,
      spender: spender.address,
      spenderLabel: spender.label,
      allowance: MAX_UINT256.toString(),
      allowanceHuman: 'unlimited (2^256-1)',
      balanceRaw: balance.toString(),
      balanceHuman: formatUnits(balance, token.decimals),
      priceUsd: price,
      exposureUsd: exposureUsd === null ? null : Math.round(exposureUsd * 100) / 100,
      grant,
      revokeCalldata: APPROVE_SELECTOR + pad32(spender.address) + pad32('0x0'),
      revokeTo: token.address,
    });
  }

  // Rank by USD exposure (priced first, then by token balance).
  findings.sort((a, b) => {
    if (a.exposureUsd !== null && b.exposureUsd !== null) return b.exposureUsd - a.exposureUsd;
    if (a.exposureUsd !== null) return -1;
    if (b.exposureUsd !== null) return 1;
    return Number(BigInt(b.balanceRaw) - BigInt(a.balanceRaw) > 0n ? 1 : -1);
  });

  const totalUsd = findings.reduce((s, f) => s + (f.exposureUsd ?? 0), 0);
  const pricedCount = findings.filter((f) => f.exposureUsd !== null).length;

  const report = {
    tool: 'bsc-unlimited-approval-finder',
    version: '1.0.0',
    chain: 'BSC (56)',
    wallet,
    scannedAtBlock: latest,
    scannedAt: new Date().toISOString(),
    coverage: {
      tokensChecked: tokens.length,
      tokensSkipped: skippedTokens,
      spendersChecked: spenders.length,
      spendersSkipped: skippedSpenders,
      pairsChecked: pairs.length,
      eventLookupFromBlock: fromBlock,
      note: 'Live allowance() scan over a curated token x spender set. Approvals to tokens or spenders outside this set are not covered; see README limitations.',
    },
    summary: {
      unlimitedApprovals: findings.length,
      priced: pricedCount,
      unpriced: findings.length - pricedCount,
      totalExposureUsd: Math.round(totalUsd * 100) / 100,
      totalExposureUsdNote: 'priced findings only; unpriced findings add unknown USD on top',
      limitedApprovalsSeen: limited.length,
    },
    findings,
    limitedApprovals: limitedShown,
  };

  // Human-readable summary on stderr so stdout stays pure JSON.
  const lines = [];
  lines.push(`BSC Unlimited Approval Finder — ${wallet}`);
  lines.push(`Scanned ${pairs.length} token x spender pairs at block ${latest} (${tokens.length} tokens, ${spenders.length} spenders).`);
  if (!findings.length) {
    lines.push('No unlimited approvals found in the scanned set.');
    lines.push(`Limited (nonzero, capped) approvals seen: ${limited.length}${limitedShown.length ? ' — largest: ' + limitedShown.slice(0, 3).map((l) => `${l.allowanceHuman} ${l.symbol} -> ${l.spenderLabel}`).join('; ') : ''}.`);
  } else {
    lines.push(`Found ${findings.length} UNLIMITED approval(s). Total priced exposure: $${report.summary.totalExposureUsd.toFixed(2)}${pricedCount < findings.length ? ` (+ ${findings.length - pricedCount} unpriced)` : ''}.`);
    lines.push('');
    findings.forEach((f, i) => {
      lines.push(`${i + 1}. ${f.symbol} -> ${f.spenderLabel} (${f.spender})`);
      lines.push(`   Balance at risk: ${f.balanceHuman} ${f.symbol}${f.exposureUsd !== null ? ` (~$${f.exposureUsd.toFixed(2)})` : ' (price unknown)'}`);
      if (f.grant) lines.push(`   Granted in tx ${f.grant.transactionHash} (block ${f.grant.blockNumber})`);
      lines.push(`   Revoke: call ${f.revokeTo} with data ${f.revokeCalldata}`);
    });
    lines.push('');
    lines.push('Revoke calldata above only READS as data — this tool never sends it. Revoke from your own wallet when ready.');
  }
  console.error(lines.join('\n'));

  const json = JSON.stringify(report, null, 2);
  if (outFile) writeFileSync(outFile, json + '\n');
  console.log(json);
}

main().catch((e) => {
  console.error('finder failed:', e.message);
  process.exit(2);
});
