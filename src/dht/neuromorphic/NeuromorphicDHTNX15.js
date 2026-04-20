/**
 * NeuromorphicDHTNX15 — Membership-protocol pub/sub.
 *
 * Extends NX-10 (inheriting synaptome, routing-topology forwarding tree,
 * churn resilience, and every prior NX-N rule) and adds a real, self-
 * organising pub/sub membership protocol on top:
 *
 *   • Subscribe routes toward hash(topic); first live axon on the path
 *     catches it. If no axon exists, the closest-to-hash node becomes
 *     the root.
 *   • When an axon's direct-subscriber count exceeds maxDirectSubs,
 *     subsequent subscribes trigger recruitment of a sub-axon (the peer
 *     on the routing path that forwarded the subscribe).
 *   • Periodic refresh keeps the tree alive; TTL expiry + hysteresis
 *     dissolve keep it pruned.
 *   • Every axon member re-subscribes on every refresh interval; a
 *     silent axon is dropped by its parent's TTL sweep.
 *   • NX-15's pickRecruitPeer override prefers forward-progress
 *     synaptome peers with highest synapse weight — axon membership is
 *     long-lived, so LTP-trusted synapses are the right backbone.
 *
 * The membership protocol is implemented by AxonManager (in
 * src/pubsub/AxonManager.js), which is protocol-agnostic. NX-15's job
 * is to provide the four routing primitives AxonManager needs:
 *
 *     routeMessage(targetId, type, payload, opts)
 *     sendDirect(peerId, type, payload)
 *     onRoutedMessage(type, handler)
 *     onDirectMessage(type, handler)
 *
 * Plus two identity accessors:
 *
 *     getSelfId()
 *     getAlivePeer(id)
 *
 * The inherited pubsubBroadcast(relayId, targetIds) one-shot API is
 * preserved unchanged (so NX-10's benchmark numbers are reproduced by
 * NX-15). A future integration phase can add a new benchmark that uses
 * the membership protocol end-to-end via PubSubAdapter → AxonManager.
 */

import { NeuromorphicDHTNX10 } from './NeuromorphicDHTNX10.js';
import { AxonManager } from '../../pubsub/AxonManager.js';

// ── Identity conversions ────────────────────────────────────────────────────
//
// The sim's NeuronNode IDs are BigInt; the adapter's topic IDs and subscriber
// IDs are 16-char lowercase hex strings. NX-15 converts at its boundary so
// every other layer stays untouched.

function topicToBigInt(topicId) {
  if (typeof topicId === 'bigint') return topicId;
  return BigInt('0x' + topicId);
}

function nodeIdToHex(id) {
  if (typeof id === 'string') return id;
  return id.toString(16).padStart(16, '0');
}

// ── NeuromorphicDHTNX15 ─────────────────────────────────────────────────────

export class NeuromorphicDHTNX15 extends NeuromorphicDHTNX10 {
  static get protocolName() { return 'Neuromorphic-NX15'; }

  constructor(opts = {}) {
    super(opts);

    // Per-node handler maps. Handlers are installed lazily when AxonManager
    // registers them for a given node.
    this._routedHandlers = new Map();  // NeuronNode → Map<type, handler>
    this._directHandlers = new Map();  // NeuronNode → Map<type, handler>

    // Per-node AxonManagers. Lazy-created on first pub/sub access so that
    // the cost is zero for nodes that never participate in a topic.
    this._axonsByNode = new Map();     // NeuronNode → AxonManager

    // Membership protocol parameters — inherited by every AxonManager we
    // create via axonFor(). The UI panel in index.html (id="nx15-panel")
    // controls these via Controls.getNX15Params() → main.js createDHT.
    // Any field left undefined uses AxonManager's default.
    this._membershipOpts = opts.membership || {};

    // sendDirect drain-loop state (see sendDirect docstring for rationale).
    this._sendQueue    = null;
    this._sendDraining = false;
  }

  // ── AxonManager lifecycle ───────────────────────────────────────────

  /**
   * Get (or lazily create) the AxonManager attached to `node`. `node` may
   * be the NeuronNode directly or its id (BigInt or hex string); the
   * returned AxonManager satisfies the PubSubAdapter transport contract.
   */
  axonFor(nodeOrId) {
    const node = this._resolveNode(nodeOrId);
    if (!node) throw Error(`NX-15: no live node for id ${nodeOrId}`);
    let axon = this._axonsByNode.get(node);
    if (axon) return axon;

    // Apply UI-tunable membership parameters; any field left undefined
    // falls through to AxonManager's compiled-in defaults.
    const m = this._membershipOpts;
    axon = new AxonManager({
      dht: this._nodeShim(node),
      maxDirectSubs:        m.maxDirectSubs,
      minDirectSubs:        m.minDirectSubs,
      refreshIntervalMs:    m.refreshIntervalMs,
      maxSubscriptionAgeMs: m.maxSubscriptionAgeMs,
      rootGraceMs:          m.rootGraceMs,
      rootSetSize:          m.rootSetSize,
      // NX-15's override: prefer existing child that is also a high-weight
      // synapse of this node. Must return an existing child; never grows
      // the axon beyond maxDirectSubs.
      pickRecruitPeer: (role, meta, subscriberId) =>
        this._pickRecruitPeer(node, role, meta, subscriberId),
    });
    this._axonsByNode.set(node, axon);
    return axon;
  }

  /**
   * Build the thin wrapper that exposes the four DHT primitives in the shape
   * AxonManager expects, with the node captured in closure.
   */
  _nodeShim(node) {
    const self = this;
    return {
      get nodeId()   { return nodeIdToHex(node.id); },
      getSelfId()    { return nodeIdToHex(node.id); },
      getAlivePeer(peerId) {
        const peer = self.nodeMap.get(topicToBigInt(peerId));
        return peer?.alive ? peer : null;
      },
      routeMessage(targetId, type, payload, opts) {
        return self.routeMessage(node, targetId, type, payload, opts);
      },
      sendDirect(peerId, type, payload) {
        return self.sendDirect(node, peerId, type, payload);
      },
      onRoutedMessage(type, handler) {
        self.onRoutedMessage(node, type, handler);
      },
      onDirectMessage(type, handler) {
        self.onDirectMessage(node, type, handler);
      },
      /** K-closest lookup — AxonManager uses this in K-closest mode. */
      findKClosest(targetId, K, opts) {
        return self.findKClosest(node, targetId, K, opts)
                   .map(peer => nodeIdToHex(peer.id));
      },
    };
  }

  _resolveNode(nodeOrId) {
    if (nodeOrId && typeof nodeOrId === 'object' && 'synaptome' in nodeOrId) {
      return nodeOrId;
    }
    return this.nodeMap.get(topicToBigInt(nodeOrId));
  }

  // ── Handler registries ──────────────────────────────────────────────

  onRoutedMessage(node, type, handler) {
    let table = this._routedHandlers.get(node);
    if (!table) { table = new Map(); this._routedHandlers.set(node, table); }
    table.set(type, handler);
  }

  onDirectMessage(node, type, handler) {
    let table = this._directHandlers.get(node);
    if (!table) { table = new Map(); this._directHandlers.set(node, table); }
    table.set(type, handler);
  }

  // ── K-closest lookup ────────────────────────────────────────────────

  /**
   * Return up to K nodes whose IDs are closest to `targetId` (as hex string),
   * using Kademlia-style iterative FIND_NODE over the local synaptome +
   * highway. Reuses the same algorithmic pattern as NX-6's addNode
   * iterative-lookup helper; returns bare NeuronNodes. K defaults to 5.
   *
   * This is the primitive the membership protocol (AxonManager K-closest
   * mode) uses to find the replicated root set for a topic: subscribe
   * STOREs at every node in the returned list, and publishers route to
   * any-of-K rather than one-true-closest. Making this function pre-
   * computes the root set in a single pass so the protocol can fan out
   * subscribe/publish without further iterative work.
   */
  findKClosest(sourceNode, targetId, K = 5, { alpha = 3, maxRounds = 20 } = {}) {
    const src = this._resolveNode(sourceNode);
    if (!src) return [];
    const targetBig = topicToBigInt(targetId);

    const candidates = new Map();   // BigInt id → NeuronNode
    const distances  = new Map();   // BigInt id → BigInt distance
    const addCandidate = (node) => {
      if (!node?.alive || candidates.has(node.id)) return;
      candidates.set(node.id, node);
      distances.set(node.id, node.id ^ targetBig);
    };

    // Seed with source node + its immediate routing tables.
    addCandidate(src);
    for (const syn of src.synaptome.values()) addCandidate(this.nodeMap.get(syn.peerId));
    if (src.highway) {
      for (const syn of src.highway.values()) addCandidate(this.nodeMap.get(syn.peerId));
    }

    const visited = new Set();
    for (let round = 0; round < maxRounds; round++) {
      const unvisited = [...candidates.values()]
        .filter(n => !visited.has(n.id))
        .sort((a, b) => distances.get(a.id) < distances.get(b.id) ? -1 : 1)
        .slice(0, alpha);
      if (unvisited.length === 0) break;

      const sizeBefore = candidates.size;
      for (const peer of unvisited) {
        visited.add(peer.id);
        for (const syn of peer.synaptome.values()) addCandidate(this.nodeMap.get(syn.peerId));
        if (peer.highway) {
          for (const syn of peer.highway.values()) addCandidate(this.nodeMap.get(syn.peerId));
        }
      }
      if (candidates.size === sizeBefore) break;
    }

    return [...candidates.values()]
      .sort((a, b) => distances.get(a.id) < distances.get(b.id) ? -1 : 1)
      .slice(0, K);
  }

  // ── Greedy single-step routing ──────────────────────────────────────

  /**
   * Return the NeuronNode we should forward toward `targetId` from `node`,
   * or `null` if `node` itself is closest (terminal). Walks synaptome and
   * highway tiers; picks the peer whose XOR distance to the target is
   * strictly smaller than `node`'s own.
   *
   * This is the single-step primitive lifted out of NX-10's lookup inner
   * loop (sans the two-hop lookahead scoring, which is a lookup-quality
   * optimisation and not needed for protocol-level routed messaging).
   */
  _greedyNextHopToward(node, targetId) {
    if (!node?.alive) return null;
    const target = topicToBigInt(targetId);
    let best = null;
    let bestDist = node.id ^ target;

    for (const syn of node.synaptome.values()) {
      const peer = this.nodeMap.get(syn.peerId);
      if (!peer?.alive) continue;
      const d = syn.peerId ^ target;
      if (d < bestDist) { bestDist = d; best = peer; }
    }
    if (node.highway) {
      for (const syn of node.highway.values()) {
        const peer = this.nodeMap.get(syn.peerId);
        if (!peer?.alive) continue;
        const d = syn.peerId ^ target;
        if (d < bestDist) { bestDist = d; best = peer; }
      }
    }
    return best;
  }

  // ── Routed messaging ────────────────────────────────────────────────

  /**
   * Walk a typed message from `originNode` toward `targetId`. Each hop may
   * inspect and optionally consume the message via its registered handler.
   *
   * The walk is synchronous in the simulator (no latency injected) —
   * matching how `lookup` already treats the hop walk. In a real network
   * each hop is a UDP/WebRTC message; the semantics of intercept + forward
   * carry over unchanged.
   *
   * Returns { consumed, atNode, hops, terminal?, exhausted? }.
   */
  async routeMessage(originNode, targetId, type, payload, opts = {}) {
    const maxHops = opts.maxHops ?? 40;
    const originId = opts.fromId ?? nodeIdToHex(originNode.id);

    let current = originNode;
    let previousId = originId;
    let hops = 0;

    while (hops < maxHops) {
      const nextHop = this._greedyNextHopToward(current, targetId);
      const isTerminal = nextHop === null;

      const result = this._deliverRouted(current, type, payload, {
        fromId:   previousId,
        targetId,
        hopCount: hops,
        isTerminal,
        node:     current,
      });

      if (result === 'consumed') return { consumed: true, atNode: current.id, hops };
      if (isTerminal) return { consumed: false, atNode: current.id, hops, terminal: true };

      previousId = nodeIdToHex(current.id);
      current = nextHop;
      hops++;
    }
    return { consumed: false, atNode: current.id, hops, exhausted: true };
  }

  _deliverRouted(node, type, payload, meta) {
    const handlers = this._routedHandlers.get(node);
    const handler = handlers?.get(type);
    if (!handler) return 'forward';
    try { return handler(payload, meta) || 'forward'; }
    catch (err) {
      console.error(`NX-15 routed handler error at ${node.id} for '${type}':`, err);
      return 'forward';
    }
  }

  // ── Point-to-point ──────────────────────────────────────────────────

  /**
   * Deliver `payload` directly to `peerId`. Returns `true` if the peer
   * was live at call time, `false` if dropped (peer dead or unknown).
   *
   * Iterative BFS-drain implementation: the liveness check and handler
   * lookup happen synchronously (so the return value is accurate and the
   * caller's eager-dead-child removal still works), but the handler
   * invocation is put on a FIFO queue drained by an outer while-loop.
   * This keeps a fan-out through a deep axon tree off the synchronous
   * call stack — otherwise a 3-level axonal tree with 20-way fan-out
   * blows past Node's ~10K frame limit and crashes with
   * "Maximum call stack size exceeded".
   *
   * Publish-time semantics are preserved: all handlers dispatched by a
   * single top-level sendDirect invocation complete before that call
   * returns, so benchmarks that count deliveries immediately after
   * publish() still see the correct numbers.
   */
  sendDirect(fromNode, peerId, type, payload) {
    const peer = this.nodeMap.get(topicToBigInt(peerId));
    if (!peer?.alive) return false;
    const handlers = this._directHandlers.get(peer);
    const handler = handlers?.get(type);
    if (!handler) return true;        // peer alive, no handler registered — no-op

    const item = {
      handler,
      payload,
      meta: { fromId: nodeIdToHex(fromNode.id), type },
      peerId: peer.id,
      type,
    };

    if (this._sendDraining) {
      // Nested call from inside another handler — enqueue; the outer
      // drain loop will pick it up.
      this._sendQueue.push(item);
      return true;
    }

    // Top-level: start a drain loop.
    this._sendQueue   = [item];
    this._sendDraining = true;
    try {
      while (this._sendQueue.length > 0) {
        const next = this._sendQueue.shift();
        try {
          next.handler(next.payload, next.meta);
        } catch (err) {
          console.error(`NX-15 direct handler error at peer ${next.peerId} for '${next.type}':`, err);
        }
      }
    } finally {
      this._sendDraining = false;
      this._sendQueue    = null;
    }
    return true;
  }

  // ── Recruitment policy: synaptome-weighted peer selection ───────────

  /**
   * Pick an EXISTING child to promote as sub-axon, preferring those that
   * also appear in this node's synaptome with high weight. High-weight
   * synapses have been validated by LTP as reliable, so promoting them
   * yields trees whose backbone sits on proven connections.
   *
   * Contract: the return value MUST already be present in role.children —
   * recruitment never grows the axon beyond maxDirectSubs. If no child
   * has a synaptome match, falls back to AxonManager's default (XOR-
   * closest existing child to the new subscriber).
   */
  _pickRecruitPeer(node, role, meta, subscriberId) {
    if (role.children.size === 0) return null;
    const selfHex = nodeIdToHex(node.id);

    // Build an index of our synaptome+highway weights keyed by hex-string peerId,
    // so we can look them up quickly while walking role.children.
    const synapseWeights = new Map();
    const tiers = [node.synaptome];
    if (node.highway) tiers.push(node.highway);
    for (const tier of tiers) {
      for (const syn of tier.values()) {
        const peer = this.nodeMap.get(syn.peerId);
        if (!peer?.alive) continue;
        synapseWeights.set(nodeIdToHex(syn.peerId), {
          weight:  syn.weight,
          latency: syn.latency ?? syn.latencyMs ?? 0,
        });
      }
    }

    let bestChildId = null;
    let bestScore = -Infinity;
    for (const childId of role.children.keys()) {
      if (childId === selfHex) continue;               // never recruit self
      const s = synapseWeights.get(childId);
      if (!s) continue;
      const score = s.weight * 1_000_000 - s.latency;
      if (score > bestScore) { bestScore = score; bestChildId = childId; }
    }
    if (bestChildId) return bestChildId;

    // No synaptome-matched child — fall through to XOR-closest existing
    // child, still excluding self.
    const subBig = topicToBigInt(subscriberId);
    let best = null;
    let bestDist = null;
    for (const childId of role.children.keys()) {
      if (childId === selfHex) continue;
      const d = BigInt('0x' + childId) ^ subBig;
      if (bestDist === null || d < bestDist) { bestDist = d; best = childId; }
    }
    return best;
  }
}
