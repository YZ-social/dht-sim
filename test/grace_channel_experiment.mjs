// grace_channel_experiment.mjs — David's authorization of Aster's two asks
// (ASTER-20260826-1140-FOURTHARM-03):
//   1. RESOURCE COMPARISON for arms A (gate, immediate close) and D (gate,
//      closes inert): open-channel min/med/max, max-connection violations,
//      non-routing channel census, retry/rebind load, memory proxy.
//   2. ARM E — bounded NON-ROUTING GRACE CHANNEL with explicit
//      channel-budget enforcement, vs immediate close, same seeds:
//      on refusal the channel survives for GRACE_MS (default 5000) unless
//      the peer is admitted meanwhile; a sweeper closes expired grace
//      channels, and if a node's TOTAL open channels exceed the physical
//      budget (100) the oldest grace channels close immediately.
//
//   SEED=42 N=1000 node test/grace_channel_experiment.mjs
import { TransportAxonaEngine } from '../src/dht/neuromorphic/TransportAxonaEngine.js';

const SEED = +(process.env.SEED || 42);
function makeLcg(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }
const N = +(process.env.N || 1000);
const L = +(process.env.LOOKUPS || 1000);
const GRACE_MS = +(process.env.GRACE_MS || 5000);
const CHAN_BUDGET = 100;
const dist = (xs) => { const s = [...xs].sort((a, b) => a - b); return `min=${s[0]} med=${s[s.length >> 1]} max=${s[s.length - 1]} avg=${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)}`; };

async function runArm(label, mode) {   // mode: 'close' | 'noclose' | 'grace'
  Math.random = makeLcg(SEED);
  const eng = new TransportAxonaEngine({ k: 20, alpha: 3, bits: 64, geoBits: 8, hashBits: 56 });
  for (let i = 0; i < N; i++) await eng.addNode(38 + Math.random() * 2, -77 + Math.random() * 2);

  let refusals = 0, admits = 0, deferredCloses = 0, budgetCloses = 0, graceExpired = 0, graceRescued = 0;
  const openCalls = new Map();       // node -> count (retry/rebind proxy)
  const graceLists = new Map();      // peer -> [{peerId, at}]
  for (const p of eng._peers.values()) {
    const orig = p._admitOrImprove?.bind(p);
    if (orig) p._admitOrImprove = (s) => { const r = orig(s); if (r) admits++; else refusals++; return r; };
    const t = p._node?.transport;
    if (!t) continue;
    const origOpen = t.openConnection.bind(t);
    t.openConnection = async (id) => { openCalls.set(p, (openCalls.get(p) ?? 0) + 1); return origOpen(id); };
    if (mode === 'noclose') t.closeConnection = async () => { deferredCloses++; };
    if (mode === 'grace') {
      const origClose = t.closeConnection.bind(t);
      graceLists.set(p, []);
      t.closeConnection = async (id) => {
        deferredCloses++;
        graceLists.get(p).push({ peerId: id, at: Date.now(), close: () => origClose(id) });
        // EXPLICIT CHANNEL-BUDGET ENFORCEMENT: total open channels must not
        // exceed the physical budget; oldest grace channels close first.
        while (t._openTo && t._openTo.size > CHAN_BUDGET && graceLists.get(p).length > 0) {
          const g = graceLists.get(p).shift();
          budgetCloses++; await g.close();
        }
      };
    }
  }

  // Grace sweeper: expire grace channels past GRACE_MS unless admitted since.
  let sweeper = null;
  if (mode === 'grace') {
    sweeper = setInterval(async () => {
      const now = Date.now();
      for (const [p, list] of graceLists) {
        const keep = [];
        for (const g of list) {
          const pid = typeof g.peerId === 'string' ? g.peerId : g.peerId;
          if (p._node.synaptome.has(typeof pid === 'bigint' ? pid : BigInt('0x' + pid))) { graceRescued++; continue; }
          if (now - g.at >= GRACE_MS) { graceExpired++; try { await g.close(); } catch { /* */ } }
          else keep.push(g);
        }
        graceLists.set(p, keep);
      }
    }, 1000);
    sweeper.unref?.();
  }

  await eng.buildRoutingTables({ bidirectional: true, maxConnections: 100 });
  await new Promise(r => setTimeout(r, mode === 'grace' ? GRACE_MS + 2500 : 1500));  // quiescence + grace expiry

  // ── RESOURCE METRICS ──
  const nodes = [...eng.nodeMap.values()];
  const chans = nodes.map(n => n.transport?._openTo?.size ?? 0);
  const syn = nodes.map(n => n.synaptome.size);
  const nonRouting = nodes.map(n => {
    let c = 0;
    for (const pid of n.transport?._openTo ?? []) {
      try { if (!n.synaptome.has(BigInt('0x' + pid))) c++; } catch { c++; }
    }
    return c;
  });
  const chanViolations = chans.filter(c => c > CHAN_BUDGET).length;
  const opens = [...openCalls.values()];
  const rss = Math.round(process.memoryUsage().rss / 1e6);

  // ── LOOKUPS (same seeded workload) ──
  const pick = makeLcg(SEED ^ 0xbeef);
  let ok = 0; const fails = { revisit: 0, exhausted: 0, shortstop: 0, other: 0 };
  for (let i = 0; i < L; i++) {
    const a = nodes[Math.floor(pick() * nodes.length)];
    const b = nodes[Math.floor(pick() * nodes.length)];
    if (a === b) { i--; continue; }
    try {
      const r = await eng.lookup(a.id, b.id);
      if (r && (r.found === true || r.success === true || r?.id === b.id)) { ok++; continue; }
      const path = r?.path ?? []; const seen = new Set(); let rev = false;
      for (const h of path) { if (seen.has(h)) { rev = true; break; } seen.add(h); }
      if (rev) fails.revisit++;
      else if ((r?.hops ?? path.length) >= 35) fails.exhausted++;
      else if ((r?.hops ?? path.length) <= 2) fails.shortstop++;
      else fails.other++;
    } catch { fails.other++; }
  }
  if (sweeper) clearInterval(sweeper);
  console.log(`[${label}]`);
  console.log(`  synaptome:    ${dist(syn)}`);
  console.log(`  openChannels: ${dist(chans)}  budgetViolations(>${CHAN_BUDGET})=${chanViolations}`);
  console.log(`  nonRouting:   ${dist(nonRouting)}  (channels open but not in synaptome)`);
  console.log(`  openCalls/node: ${dist(opens)}  rssMB=${rss}`);
  console.log(`  gate: admits=${admits} refusals=${refusals} deferredCloses=${deferredCloses} budgetCloses=${budgetCloses} graceExpired=${graceExpired} graceRescued=${graceRescued}`);
  console.log(`  LOOKUPS ${ok}/${L}  fails: ${Object.entries(fails).map(([k, v]) => k + '=' + v).join(' ')}`);
  eng.dispose?.();
}

await runArm('A immediate-close', 'close');
await runArm('D closes-inert   ', 'noclose');
await runArm(`E grace-${GRACE_MS}ms  `, 'grace');
process.exit(0);
