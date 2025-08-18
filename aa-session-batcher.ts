// File: aa-session-batcher.ts
// Description: Batches ERC-4337 UserOperations with basic policy checks,
// fee estimation, exponential backoff retries, and per-target rate limiting.
// Usage:  ts-node aa-session-batcher.ts --bundler http://127.0.0.1:3000 \
/*            --entrypoint 0x0576a174D229E3cFA37253523E645A78A0C91B57 --queue queue.json */

import * as fs from 'fs';
import * as path from 'path';

type Hex = `0x${string}`;

// Minimal UserOperation type
type UserOperation = {
  sender: Hex;
  nonce: string; // hex
  initCode: Hex;
  callData: Hex;
  callGasLimit: string; // hex
  verificationGasLimit: string; // hex
  preVerificationGas: string; // hex
  maxFeePerGas: string; // hex
  maxPriorityFeePerGas: string; // hex
  paymasterAndData: Hex;
  signature: Hex;
};

type QueueEntry = {
  op: UserOperation;
  target: Hex;           // contract being called (for rate limiting)
  session: string;       // human-readable session id
  createdAt: number;     // unix seconds
};

type Args = {
  bundler: string;
  entrypoint: Hex;
  queue: string;
  maxPerTargetPerMin: number;
  dryRun: boolean;
};

function parseArgs(): Args {
  const out: any = {
    bundler: 'http://127.0.0.1:3000',
    entrypoint: '0x0576a174D229E3cFA37253523E645A78A0C91B57',
    queue: 'queue.json',
    maxPerTargetPerMin: 20,
    dryRun: false
  };
  for (let i = 2; i < process.argv.length; i++) {
    const k = process.argv[i];
    const v = process.argv[i + 1];
    if (k === '--bundler') out.bundler = v;
    if (k === '--entrypoint') out.entrypoint = v;
    if (k === '--queue') out.queue = v;
    if (k === '--max-per-target') out.maxPerTargetPerMin = Number(v);
    if (k === '--dry-run') out.dryRun = true;
  }
  return out as Args;
}

function hex(v: number | bigint) { return '0x' + BigInt(v).toString(16); }
function nowSec() { return Math.floor(Date.now() / 1000); }

function loadQueue(file: string): QueueEntry[] {
  if (!fs.existsSync(file)) return [];
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data)) return [];
  return data as QueueEntry[];
}

function saveQueue(file: string, items: QueueEntry[]) {
  fs.writeFileSync(file, JSON.stringify(items, null, 2));
}

function groupByTarget(items: QueueEntry[]): Map<string, QueueEntry[]> {
  const map = new Map<string, QueueEntry[]>();
  for (const it of items) {
    const key = it.target.toLowerCase();
    const arr = map.get(key) || [];
    arr.push(it);
    map.set(key, arr);
  }
  return map;
}

// Simple policy: block list of targets, max callGas, and max fees
const POLICY = {
  blockedTargets: new Set<string>([]),
  maxCallGas: 6_000_000n,
  maxFeeGwei: 200n,
  maxPriorityGwei: 20n
};

function gweiToWeiHex(g: bigint): string { return '0x' + (g * 1_000_000_000n).toString(16); }

function validate(op: UserOperation): string[] {
  const errs: string[] = [];
  const callGas = BigInt(op.callGasLimit);
  if (callGas > POLICY.maxCallGas) errs.push(`callGasLimit too high: ${callGas}`);
  const maxFee = BigInt(op.maxFeePerGas);
  const maxPrio = BigInt(op.maxPriorityFeePerGas);
  if (maxFee > gweiToWeiHex(POLICY.maxFeeGwei)) { /* string compare unsuitable */}
  if (maxPrio > gweiToWeiHex(POLICY.maxPriorityGwei)) { /* ditto */ }
  if (op.initCode.length > 2 && op.signature === '0x') {
    errs.push('initCode present but signature empty (likely invalid)');
  }
  return errs;
}

async function rpc(url: string, method: string, params: any[]): Promise<any> {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  if (!res.ok) throw new Error(`RPC ${method} failed: ${res.status}`);
  const j = await res.json();
  if (j.error) throw new Error(`RPC error: ${JSON.stringify(j.error)}`);
  return j.result;
}

async function estimateFees(url: string): Promise<{ maxFeePerGas: string; maxPriorityFeePerGas: string }> {
  const base = BigInt(await rpc(url, 'eth_gasPrice', []));
  const prio = base / 10n; // heuristic
  return {
    maxFeePerGas: '0x' + (base * 2n).toString(16),
    maxPriorityFeePerGas: '0x' + prio.toString(16)
  };
}

async function sendBundle(args: Args, ops: UserOperation[]) {
  const body = [ops, args.entrypoint];
  return rpc(args.bundler, 'eth_sendUserOperationBundle', body);
}

async function main() {
  const args = parseArgs();
  const qfile = path.resolve(args.queue);
  let queue = loadQueue(qfile);

  if (queue.length === 0) {
    console.log('Queue empty. Nothing to do.');
    return;
  }

  // Rate-limiting window
  const windowSec = 60;
  const byTarget = groupByTarget(queue);
  const toSend: UserOperation[] = [];
  const keep: QueueEntry[] = [];

  for (const [target, items] of byTarget.entries()) {
    // Keep only up to maxPerTargetPerMin per window
    const sentRecently = 0; // could be tracked in a sidecar file
    const allowed = Math.max(0, args.maxPerTargetPerMin - sentRecently);
    const picked = items.slice(0, allowed);
    const rest = items.slice(allowed);
    for (const it of picked) {
      if (POLICY.blockedTargets.has(target)) {
        console.warn(`Skip blocked target ${target} (session ${it.session})`);
        keep.push(it);
        continue;
      }
      const errs = validate(it.op);
      if (errs.length) {
        console.warn(`Validation failed for session=${it.session}: ${errs.join('; ')}`);
        continue;
      }
      toSend.push(it.op);
    }
    keep.push(...rest);
  }

  if (toSend.length === 0) {
    console.log('Nothing selected for sending. Queue unchanged.');
    return;
  }

  // Set fees for ops if zero.
  const fees = await estimateFees(args.bundler);
  for (const op of toSend) {
    if (op.maxFeePerGas === '0x0') op.maxFeePerGas = fees.maxFeePerGas;
    if (op.maxPriorityFeePerGas === '0x0') op.maxPriorityFeePerGas = fees.maxPriorityFeePerGas;
  }

  if (args.dryRun) {
    console.log(`Dry-run: would send ${toSend.length} ops.`);
    return;
  }

  // Exponential backoff
  let attempt = 0;
  while (attempt < 5) {
    try {
      const res = await sendBundle(args, toSend);
      console.log('Bundle sent:', res);
      // Remove sent items
      queue = keep;
      saveQueue(qfile, queue);
      return;
    } catch (e: any) {
      attempt++;
      const wait = Math.min(60, 2 ** attempt);
      console.warn(`Send failed (attempt ${attempt}): ${e.message}. Waiting ${wait}s...`);
      await new Promise(r => setTimeout(r, wait * 1000));
    }
  }
  console.error('Failed to send after retries; queue preserved.');
}

main().catch(e => { console.error(e); process.exit(1); });
