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
    // registers them for a given node. WeakMap semantics are not required —
    // nodes live for the lifetime of the DHT, and we want fast iteration, so
    // plain Maps are fine.
    this._routedHandlers = new Map();  // NeuronNode → Map<type, handler>
    this._directHandlers = new Map();  // NeuronNode → Map<type, handler>

    // Per-node AxonManagers. Lazy-created on first pub/sub access so that
    // the cost is zero for nodes that never participate in a topic.
    this._axonsByNode = new Map();     // NeuronNode → AxonManager

    // Adapter-ready: any benchmark or app that wants to wire a PubSubAdapter
    // to this DHT can call `dht.axonFor(nodeId)` to get the per-node axon
    // and then construct an adapter against it:
    //     const axon    = dht.axonFor(nodeId);
    //     const adapter = new PubSubAdapter({ transport: axon });
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

    axon = new AxonManager({
      dht: this._nodeShim(node),
      // NX-15's override: prefer forward-progress synaptome peers by weight.
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
   * Deliver `payload` directly to `peerId`. Returns `true` if the peer was
   * live at call time, `false` if dropped (peer dead or unknown). This is
   * fire-and-forget — the handler fires synchronously in the simulator;
   * the real network would substitute a UDP/WebRTC send.
   */
  sendDirect(fromNode, peerId, type, payload) {
    const peer = this.nodeMap.get(topicToBigInt(peerId));
    if (!peer?.alive) return false;
    const handlers = this._directHandlers.get(peer);
    const handler = handlers?.get(type);
    if (!handler) return true;
    try {
      handler(payload, { fromId: nodeIdToHex(fromNode.id), type });
    } catch (err) {
      console.error(`NX-15 direct handler error at peer ${peer.id} for '${type}':`, err);
    }
    return true;
  }

  // ── Recruitment policy: synaptome-weighted peer selection ───────────

  /**
   * Pick a sub-axon recruit from `node`'s synaptome — the peer that makes
   * strict forward progress toward the new subscriber AND has the highest
   * synapse weight (ties broken by lowest latency). Falls back to the
   * default (the peer that forwarded the subscribe) if no suitable
   * synaptome candidate exists.
   *
   * Rationale: axon membership is long-lived. High-weight synapses have
   * been validated by LTP as reliable. Picking them as recruits yields
   * trees whose backbone sits on proven connections, reducing the amount
   * of churn-induced re-subscription the membership protocol has to do.
   */
  _pickRecruitPeer(node, role, meta, subscriberId) {
    const subTarget = topicToBigInt(subscriberId);
    const selfDist = node.id ^ subTarget;

    let bestPeerId = null;
    let bestScore = -Infinity;

    // Search synaptome + highway for forward-progress candidates.
    const tiers = [node.synaptome];
    if (node.highway) tiers.push(node.highway);

    for (const tier of tiers) {
      for (const syn of tier.values()) {
        const d = syn.peerId ^ subTarget;
        if (d >= selfDist) continue;                   // not forward progress
        const peer = this.nodeMap.get(syn.peerId);
        if (!peer?.alive) continue;
        // Score: weight dominates, latency is a tie-breaker. Weight ∈ [0,1];
        // multiplying by 1_000_000 gives it priority over any sensible
        // latency value (typically tens to hundreds of ms).
        const score = syn.weight * 1_000_000 - (syn.latency ?? syn.latencyMs ?? 0);
        if (score > bestScore) { bestScore = score; bestPeerId = syn.peerId; }
      }
    }

    if (bestPeerId !== null) return nodeIdToHex(bestPeerId);
    return meta.fromId;  // default fallback
  }
}
