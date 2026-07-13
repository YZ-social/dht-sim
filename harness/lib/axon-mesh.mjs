// =====================================================================
// axon-mesh.mjs — shared primitives for the real-kernel pub/sub churn suite.
//
// Drives the SHIPPED @axona/protocol AxonaPeer pub/sub over the kernel
// SimNetwork (no axonaManager injection, no pickRelayPeer override — the
// production default manager). Nodes are minted with FAST sim identities
// (no Ed25519 keygen; sim-only, relaxed-verify profile) so 50k-node meshes
// build in seconds and replacement churn is cheap.
//
// Exposes: keyspace setup, mesh build, replacement churn (global/relay/root),
// targeted re-wire + maintenance, subscribe/publish, and axon-tree
// introspection (delivery, depth, fan-out, roots, relays, orphans).
// =====================================================================

import {
  AxonaPeer, AxonaDomain, NeuronNode, Synapse, SimNetwork, simTransport,
  createNodeIdentity, createAuthorIdentity, deriveTopicId, clz264, KERNEL_VERSION,
  configureKeyspace, getKeyspace,
} from '@axona/protocol';
import { buildXorRoutingTable } from '@axona/protocol/utils/geo.js';

export { KERNEL_VERSION, createAuthorIdentity, deriveTopicId };
export const wait = (ms) => new Promise(r => setTimeout(r, ms));

/** Shrink the keyspace for scale (sim-only). Call ONCE before minting peers. */
export function shrinkKeyspace(hashBits) {
  if (hashBits && hashBits !== 256) configureKeyspace({ hashBits });
  return getKeyspace();
}

// Spread nodes across the globe so topic-id region bytes vary (realistic root
// election). Deterministic-ish per call is fine; we only need dispersion.
function randLatLng(spread) {
  if (!spread) return { lat: 38.0, lng: -77.0 };
  return { lat: Math.random() * 140 - 70, lng: Math.random() * 360 - 180 };
}

// ── peer lifecycle ─────────────────────────────────────────────────────
export async function makePeer(network, domain, opts) {
  const { K, refresh, renew, spread, role = 'node' } = opts;
  const { lat, lng } = randLatLng(spread);
  const identity = await createNodeIdentity({ lat, lng, fast: true });   // no keygen
  const transport = simTransport({ network, identity, heartbeatMs: 0 });
  await transport.start(identity.id);
  const node = new NeuronNode({ id: BigInt('0x' + identity.id), lat, lng });
  node.transport = transport;
  const peer = new AxonaPeer({ domain, node, nodeIdentity: identity, transport });
  await peer.start();
  const am = peer._requireAxonaManager?.('churn-init');
  if (am) {
    am.refreshIntervalMs = refresh; am.renewMs = renew;
    // ITER_ROOT=1: replace the default-manager's LOCAL-ONLY findKClosest (synaptome
    // -bounded, the suspected region bias) with the iterative network-probing
    // peer.findKClosest — the same path the base DHT lookup() uses. Lets us A/B
    // whether pub/sub root resolution is what caps cross-region delivery.
    if (process.env.ITER_ROOT === '1' && am.dht) {
      am.dht.findKClosest = async (targetBig, k = 5) => peer.findKClosest(targetBig, k);
    }
    am.start?.();
  }
  // received: msgId(hex) -> first-seen wall-clock; the delivery ledger. Filled by
  // the per-subscription callback passed to peer.sub() (see driver subscribe()).
  return { peer, node, hex: identity.id, big: node.id, role, am, author: null, bornAt: Date.now(), received: new Map() };
}

// id-sorted snapshot of the live set — built ONCE per wiring pass and reused
// across every wireInto call (buildXorRoutingTable wants id-sorted input).
export function sortedNodes(byBig) {
  return [...byBig.values()].map(x => x.node).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// Wire one peer to its K XOR-closest live neighbours (bidirectional synapses),
// then open the sim channels. `sorted` is the shared id-sorted node array.
export async function wireInto(p, sorted, byBig, K) {
  const cands = buildXorRoutingTable(p.node.id, sorted, K, Infinity);
  for (const cand of cands) {
    if (cand.id === p.node.id) continue;
    if (!p.node.synaptome.has(cand.id)) {
      const syn = new Synapse({ peerId: cand.id, latencyMs: 1, stratum: clz264(p.node.id ^ cand.id) });
      syn.weight = 0.5; syn.inertia = 0; syn._addedBy = 'churn';
      p.node.synaptome.set(cand.id, syn);
    }
    const other = byBig.get(cand.id);
    if (other && !other.node.synaptome.has(p.node.id)) {
      const rsyn = new Synapse({ peerId: p.node.id, latencyMs: 1, stratum: clz264(other.node.id ^ p.node.id) });
      rsyn.weight = 0.5; rsyn.inertia = 0; rsyn._addedBy = 'churn';
      other.node.synaptome.set(p.node.id, rsyn);
    }
  }
  for (const peerBig of p.node.synaptome.keys()) {
    const t = byBig.get(peerBig);
    if (t) { try { await p.peer._transport.openConnection(t.hex); } catch { /* */ } }
  }
}

// Build an N-node mesh, fully wired. Returns the mesh state object.
export async function buildMesh({ N, K, refresh, renew, spread }) {
  const network = new SimNetwork();
  const domain  = new AxonaDomain();
  const byBig   = new Map();
  for (let i = 0; i < N; i++) {
    const p = await makePeer(network, domain, { K, refresh, renew, spread });
    byBig.set(p.big, p);
  }
  const sorted = sortedNodes(byBig);
  for (const p of byBig.values()) await wireInto(p, sorted, byBig, K);
  const state = { network, domain, byBig, K, refresh, renew, spread, _warmSeed: 0 };
  // Optional initial training: WARMUP_LOOKUPS random lookups (LTP / long-range
  // highway learning) so the mesh is globally navigable.
  await trainLookups(state, +(process.env.WARMUP_LOOKUPS || 0));
  return state;
}

// Train the mesh: random lookups grow long-range synapses (the navigability the
// benchmark's mesh has). Deterministic spread (no Math.random — resumable), but
// the seed advances across calls so continuous warmups keep exploring new pairs.
export async function trainLookups(state, n) {
  if (!n || n <= 0) return;
  const list = [...state.byBig.values()];
  let s = state._warmSeed || 0;
  for (let i = 0; i < n; i++, s++) {
    const src = list[(s * 2654435761 >>> 0) % list.length];
    const tgt = list[((s * 40503 + 7) >>> 0) % list.length].big;
    try { await src.peer.lookup(tgt); } catch { /* */ }
  }
  state._warmSeed = s;
}

// One continuous warm cycle: train the mesh (lookups) AND heal the tree (refresh
// ticks + prune). Run after EVERY action (churn increment, before each measure)
// so the network is always settling toward steady state — "when in doubt, warm it up".
export async function warmCycle(state, { lookups = 0, refreshSteps = 3, stepMs = 400 } = {}) {
  await trainLookups(state, lookups);
  for (let i = 0; i < refreshSteps; i++) {
    for (const p of state.byBig.values()) { try { await p.am?.refreshTick?.(); } catch { /* */ } }
    await maintain(state, []);   // prune dead refs only (no O(N²) re-wire)
    await wait(stepMs);
  }
}

// Prune dead synapses everywhere (cheap, O(total synapses)). Then re-wire ONLY
// the affected nodes (new joiners + survivors who lost a synapse) against the
// current live set — scalable maintenance, vs re-wiring all N each round.
export async function maintain(state, affected) {
  const { byBig, K } = state;
  for (const p of byBig.values()) {
    for (const peerBig of [...p.node.synaptome.keys()]) if (!byBig.has(peerBig)) p.node.synaptome.delete(peerBig);
  }
  const sorted = sortedNodes(byBig);
  const todo = affected ?? [...byBig.values()];
  for (const p of todo) if (byBig.has(p.big)) await wireInto(p, sorted, byBig, K);
  return sorted;
}

// ── churn ──────────────────────────────────────────────────────────────
// Remove `victims`, then mint + wire the SAME COUNT of fresh nodes with NEW
// transport ids → N stays constant, replacements land at new XOR positions.
// Returns { killed, added:[newPeers] }. Survivors that lost a synapse to a
// victim + all new joiners are re-wired (targeted maintenance).
export async function replaceChurn(state, victims) {
  const { network, domain, byBig, K, refresh, renew, spread } = state;
  const victimBig = new Set(victims.map(v => v.big));
  for (const v of victims) { try { await v.peer.stop?.(); } catch { /* */ } }
  // survivors who pointed at a victim need a re-wire
  const losers = [];
  for (const p of byBig.values()) {
    if (victimBig.has(p.big)) continue;
    let lost = false;
    for (const vb of victimBig) if (p.node.synaptome.delete(vb)) lost = true;
    if (lost) losers.push(p);
  }
  for (const vb of victimBig) byBig.delete(vb);
  // mint replacements
  const added = [];
  for (let i = 0; i < victims.length; i++) {
    const p = await makePeer(network, domain, { K, refresh, renew, spread });
    byBig.set(p.big, p);
    added.push(p);
  }
  await maintain(state, [...added, ...losers]);
  return { killed: victims.length, added };
}

// ── realistic churn primitives (for the route-substrate study) ──────────
// A node leaves: stop it (closes channels bilaterally, network unregisters),
// drop it from the live set, and prune dead refs from survivors. NO re-wire,
// NO replacement — this is pure departure. Breaks PATHS, not addresses.
export async function removeNodes(state, victims) {
  const { byBig } = state;
  const vset = new Set(victims.map(v => v.big));
  for (const v of victims) { try { await v.peer.stop?.(); } catch { /* */ } }
  for (const vb of vset) byBig.delete(vb);
  for (const p of byBig.values())
    for (const pb of [...p.node.synaptome.keys()]) if (!byBig.has(pb)) p.node.synaptome.delete(pb);
  return vset;
}

// A node joins: mint `count` fresh peers with NEW transport ids at NEW keyspace
// positions (NOT reused). Returned UNWIRED — the caller bootstraps them. This is
// the hard case: a fresh address nobody has a synapse to yet.
export async function mintNewcomers(state, count) {
  const { network, domain, byBig, K, refresh, renew, spread } = state;
  const added = [];
  for (let i = 0; i < count; i++) {
    const p = await makePeer(network, domain, { K, refresh, renew, spread });
    byBig.set(p.big, p);
    added.push(p);
  }
  return added;
}

// Seed-only bootstrap: wire a newcomer to S RANDOM live seeds (mutual synapse +
// open channel) — NOT its K-closest neighbours. This is the realistic floor:
// the newcomer is reachable only from a few scattered seeds; the nodes in its
// own keyspace neighbourhood (where a greedy A→newcomer walk actually lands)
// do NOT know it yet. Warmup (self-lookup + LTP) is what later weaves it into
// its neighbourhood — that's the heal that lifts floor → ceiling.
export async function seedBootstrap(state, p, S = 3) {
  const live = [...state.byBig.values()].filter(x => x.big !== p.big);
  if (!live.length) return;
  const seen = new Set();
  for (let i = 0; i < S && seen.size < live.length; i++) {
    let seed; do { seed = live[Math.floor(Math.random() * live.length)]; } while (seen.has(seed.big));
    seen.add(seed.big);
    if (!p.node.synaptome.has(seed.big)) {
      const syn = new Synapse({ peerId: seed.big, latencyMs: 1, stratum: clz264(p.node.id ^ seed.big) });
      syn.weight = 0.5; syn.inertia = 0; syn._addedBy = 'bootstrap';
      p.node.synaptome.set(seed.big, syn);
    }
    if (!seed.node.synaptome.has(p.big)) {
      const rsyn = new Synapse({ peerId: p.big, latencyMs: 1, stratum: clz264(seed.node.id ^ p.big) });
      rsyn.weight = 0.5; rsyn.inertia = 0; rsyn._addedBy = 'bootstrap';
      seed.node.synaptome.set(p.big, rsyn);
    }
    try { await p.peer._transport.openConnection(seed.hex); } catch { /* */ }
  }
}

// Realizable, oracle-free "welcome push": a newcomer integrates ITSELF.
// 1. findKClosest(ownId) — a real network probe (no global knowledge; the node
//    only needs its own id) discovers its true K-closest live neighbours,
//    starting from its seed links.
// 2. Form a MUTUAL synapse with each — models an authenticated first-party
//    connection the newcomer opens to a neighbour it discovered: BOTH sides
//    adopt the peer. (Distinct from the eclipse case B-3 blocks — that's
//    unauthenticated gossip injection; this is a verified bilateral channel.)
// This is what makes the newcomer reachable: its neighbours now hold it in
// their OUTGOING tables, so a greedy walk to its region lands on it.
export async function welcomePush(state, p, K = 20) {
  let found = [];
  try { found = (await p.peer.findKClosest(p.big, K)) || []; } catch { /* */ }
  let wired = 0;
  for (const raw of found) {
    const nbBig = (typeof raw === 'bigint') ? raw : BigInt('0x' + String(raw));
    if (nbBig === p.big) continue;
    const nb = state.byBig.get(nbBig);
    if (!nb) continue;                                  // discovered id not live → skip
    if (!p.node.synaptome.has(nbBig)) {
      const s = new Synapse({ peerId: nbBig, latencyMs: 1, stratum: clz264(p.node.id ^ nbBig) });
      s.weight = 0.5; s.inertia = 0; s._addedBy = 'welcome'; p.node.synaptome.set(nbBig, s);
    }
    if (!nb.node.synaptome.has(p.big)) {
      const r = new Synapse({ peerId: p.big, latencyMs: 1, stratum: clz264(nb.node.id ^ p.big) });
      r.weight = 0.5; r.inertia = 0; r._addedBy = 'welcome'; nb.node.synaptome.set(p.big, r);
      wired++;
    }
    try { await p.peer._transport.openConnection(nb.hex); } catch { /* */ }
  }
  return { found: found.length, wired };
}

// Advance the network: run refresh ticks on every live peer + PRUNE dead refs
// (no re-wire — replaceChurn already wired the new nodes; a full re-wire here is
// O(N²) and unnecessary), repeated over `ms` so subscribers re-home + tree heals.
export async function warmUp(state, ms, stepMs = 600) {
  const steps = Math.max(1, Math.round(ms / stepMs));
  for (let i = 0; i < steps; i++) {
    for (const p of state.byBig.values()) { try { await p.am?.refreshTick?.(); } catch { /* */ } }
    await maintain(state, []);      // prune-only (empty affected ⇒ no re-wire)
    await wait(stepMs);
  }
}

// ── tree introspection ───────────────────────────────────────────────────
export function roleOf(p, topicBig) { return p.peer._axonaManager?.axonRoles?.get(topicBig) ?? null; }

// Classify live tree members for targeted churn.
export function classifyTree(state, topicBig) {
  const roots = [], relays = [], leaves = [];
  for (const p of state.byBig.values()) {
    const r = roleOf(p, topicBig);
    if (!r) continue;
    if (r.isRoot || r.isInRootSet) roots.push(p);
    else if (r.isSubaxon || (r.children?.size ?? 0) > 0) relays.push(p);
    else if ((r.subscribers?.size ?? 0) >= 0) leaves.push(p);
  }
  return { roots, relays, leaves };
}

// Tree shape + health. `trueRootSet` is from findKClosest(topicBig).
export function treeStats(state, topicBig, trueRootSet) {
  const roleByBig = new Map();
  for (const p of state.byBig.values()) { const r = roleOf(p, topicBig); if (r) roleByBig.set(p.big, r); }
  // depth top-down from roots via children flagged isSubaxon
  const depthFrom = (big, seen) => {
    if (seen.has(big)) return 0; seen.add(big);
    const r = roleByBig.get(big); if (!r) return 0;
    let mx = 0;
    for (const cb of (r.children ?? [])) {
      const cr = roleByBig.get(cb);
      if (cr && (cr.isSubaxon || (cr.children?.size ?? 0) > 0) && roleByBig.has(cb)) mx = Math.max(mx, 1 + depthFrom(cb, seen));
    }
    return mx;
  };
  let depth = 0, roots = 0, rootsInTrue = 0, spurious = 0, subaxons = 0;
  const fanouts = [];
  for (const [big, r] of roleByBig) {
    if (r.isRoot || r.isInRootSet) { roots++; if (trueRootSet?.has(big)) rootsInTrue++; else spurious++; depth = Math.max(depth, depthFrom(big, new Set())); }
    if (r.isSubaxon || (r.children?.size ?? 0) > 0) { subaxons++; fanouts.push((r.children?.size ?? 0) + (r.subscribers?.size ?? 0)); }
  }
  fanouts.sort((a, b) => a - b);
  return {
    depth, roots, rootsInTrue, spuriousRoots: spurious, subaxons,
    maxFanout: fanouts[fanouts.length - 1] ?? 0,
    medianFanout: fanouts[fanouts.length >> 1] ?? 0,
  };
}

// ── delivery measurement ───────────────────────────────────────────────
let SEQ = 0;
export async function publish(publisher, topic, body) {
  const msgId = String(await publisher.peer.pub(topic, body + ':' + (SEQ++), { signWith: publisher.author }));
  return msgId;
}
// fraction of `subs` whose ledger contains msgId
export function deliveredCount(subs, msgId) {
  let n = 0; for (const s of subs) if (s.received.has(String(msgId))) n++; return n;
}
