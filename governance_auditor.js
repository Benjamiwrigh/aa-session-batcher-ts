// File: governance_auditor.js
// Description: Static auditor for DAO proposal call data against a set of
// dangerous patterns (e.g., SELFDESTRUCT-like, delegatecall, role changes).
// Works offline with ABI fragments and a JSON list of queued calls.
// Usage: node governance_auditor.js --abi erc20.json --calls calls.json

const fs = require('fs');

function parseArgs() {
  const args = { abi: 'abi.json', calls: 'calls.json' };
  for (let i = 2; i < process.argv.length; i += 2) {
    if (process.argv[i] === '--abi') args.abi = process.argv[i+1];
    if (process.argv[i] === '--calls') args.calls = process.argv[i+1];
  }
  return args;
}

// Minimal ABI selector index
function buildSelectorIndex(abi) {
  const crypto = require('crypto');
  const idx = {};
  for (const f of abi) {
    if (f.type !== 'function') continue;
    const sig = `${f.name}(${(f.inputs||[]).map(i=>i.type).join(',')})`;
    const sel = '0x' + crypto.createHash('keccak256').update(sig).digest('hex').slice(0,8);
    idx[sel] = { name: f.name, inputs: f.inputs||[], stateMutability: f.stateMutability||'nonpayable' };
  }
  return idx;
}

// Dangerous patterns
const RULES = [
  { id: 'delegatecall', regex: /delegatecall/i, weight: 40, desc: 'Potential delegatecall use' },
  { id: 'upgrade-proxy', regex: /upgrade.*(implementation|proxy)/i, weight: 25, desc: 'Proxy upgrade' },
  { id: 'role-admin', regex: /(grant|revoke).*role/i, weight: 15, desc: 'Role change' },
  { id: 'pause', regex: /pause|unpause/i, weight: 10, desc: 'Pausing contract' },
  { id: 'mint', regex: /mint/i, weight: 20, desc: 'Token minting' },
];

function analyzeCall(selectorIndex, call) {
  const res = { risk: 0, reasons: [], selector: call.data.slice(0,10) };
  const sel = res.selector;
  const meta = selectorIndex[sel];
  if (!meta) {
    res.risk += 10;
    res.reasons.push('Unknown selector (not in ABI)');
  } else {
    const name = meta.name.toLowerCase();
    for (const rule of RULES) {
      if (rule.regex.test(name)) { res.risk += rule.weight; res.reasons.push(rule.desc); }
    }
    if (meta.stateMutability === 'payable') { res.risk += 5; res.reasons.push('Payable call'); }
  }
  // Basic value check
  if (Number(call.value || 0) > 0) { res.risk += 5; res.reasons.push('ETH value attached'); }
  return res;
}

function main() {
  const { abi, calls } = parseArgs();
  const abiJson = JSON.parse(fs.readFileSync(abi, 'utf8'));
  const selectorIndex = buildSelectorIndex(abiJson);
  const callsJson = JSON.parse(fs.readFileSync(calls, 'utf8'));

  const results = [];
  for (const c of callsJson) {
    const r = analyzeCall(selectorIndex, c);
    r.target = c.to;
    results.push(r);
  }

  const totalRisk = results.reduce((a, b) => a + b.risk, 0);
  const avg = results.length ? (totalRisk / results.length).toFixed(2) : "0.00";
  const report = { avgRisk: avg, items: results };
  console.log(JSON.stringify(report, null, 2));
}

if (require.main === module) main();
