/**
 * RoutingTree — Routing-topology-aware forwarding tree for scalable pub/sub.
 *
 * Instead of building an overlay tree from XOR partitions or geographic
 * clustering, this tree mirrors the actual routing topology.  When a node
 * has more subscribers than its capacity, it examines its synaptome to find
 * which direct connection (synapse) is the first hop toward the most
 * subscribers.  That connection becomes a forwarder and takes ownership of
 * those subscribers.  Recursive: forwarders apply the same rule.
 *
 * Subscription interception: when the tree already exists, new subscribers
 * are routed down through the tree — at each level, assigned to the
 * forwarder that is the first hop toward the subscriber.  This naturally
 * captures subscribers at the nearest tree node.
 *
 * Delivery:
 *   - Tree node → forwarder: 1 hop (direct synapse, no DHT lookup)
 *   - Leaf tree node → subscriber: DHT lookup (but shorter, because the
 *     tree node is already on the routing path toward the subscriber)
 *
 * Key property: the tree structure mirrors message flow, so forwarding
 * adds no extra routing overhead.  Total hops per subscriber ≈ flat lookup,
 * but fan-out per node is bounded by capacity.
 *
 * Used by NX-10's pubsubBroadcast().
 */

import { roundTripLatency } from '../../utils/geo.js';

// ── Tree Node ─────────────────────────────────────────────────────────────────

class TreeNode {
  constructor(nodeId, parent = null, depth = 0) {
    this.nodeId      = nodeId;
    this.parent      = parent;
    this.depth       = depth;
    this.subscribers = new Set();       // leaf subscriber nodeIds (delivered via DHT lookup)
    this.forwarders  = new Map();       // forwarderId → TreeNode (delivered via direct send)
    this.lastActive  = 0;
  }

  /** Total entries this node must send to (forwarders + direct subscribers) */
  get fanOut() {
    return this.forwarders.size + this.subscribers.size;
  }

  get subtreeSize() {
    let n = this.subscribers.size;
    for (const child of this.forwarders.values()) n += child.subtreeSize;
    return n;
  }
}

// ── Routing Tree ──────────────────────────────────────────────────────────────

export class RoutingTree {
  /**
   * @param {object}  dht       — DHT instance
   * @param {bigint}  relayId   — root relay node ID
   * @param {number}  capacity  — max entries per tree node (default 32)
   * @param {number}  ttl       — ticks before pruning inactive subscriber
   */
  constructor(dht, relayId, { capacity = 32, ttl = 10 } = {}) {
    this.dht         = dht;
    this.relayId     = relayId;
    this.root        = new TreeNode(relayId, null, 0);
    this.capacity    = capacity;
    this.ttl         = ttl;
    this.tick        = 0;
    this._dirty      = true;

    /** subscriberId → TreeNode that owns it */
    this.subIndex    = new Map();
    /** nodeId → TreeNode (all tree nodes including root) */
    this.branchIndex = new Map();
    this.branchIndex.set(relayId, this.root);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  get branchCount() { return this.branchIndex.size; }

  get depth() {
    let max = 0;
    for (const b of this.branchIndex.values()) {
      if (b.depth > max) max = b.depth;
    }
    return max;
  }

  // ── Broadcast ──────────────────────────────────────────────────────────────

  /**
   * @param {Set<bigint>} targetSet — subscriber IDs
   * @returns {{ hops: number[], times: number[], maxNodeLookups: number,
   *             treeDepth: number, avgSubsPerNode: number }}
   */
  async broadcast(targetSet) {
    this.tick++;

    // Rebuild tree if subscriber set changed
    if (this._dirty || this._subscribersChanged(targetSet)) {
      this._buildTree(targetSet);
      this._dirty = false;
    } else {
      // Renew existing subscriptions
      for (const subId of targetSet) {
        const branch = this.subIndex.get(subId);
        if (branch) branch.lastActive = this.tick;
      }
    }

    // Deliver through tree
    const hops  = [];
    const times = [];
    const nodeLookups = new Map();
    await this._deliverFrom(this.root, 0, 0, hops, times, nodeLookups);

    // Prune
    this._prune();

    // Metrics
    let maxNodeLookups = 0;
    for (const count of nodeLookups.values()) {
      if (count > maxNodeLookups) maxNodeLookups = count;
    }

    const avgSubs = this.branchIndex.size > 0
      ? this.subIndex.size / this.branchIndex.size
      : 0;

    return { hops, times, maxNodeLookups, treeDepth: this.depth, avgSubsPerNode: avgSubs };
  }

  // ── Tree Construction (Routing-Topology-Aware) ─────────────────────────────

  /**
   * Build the tree from scratch.  All subscribers are assigned to root,
   * then overflow is delegated recursively by selecting the busiest
   * gateway synapse as a forwarder.
   */
  _buildTree(targetSet) {
    // Clear old tree (keep root)
    this.subIndex.clear();
    this.branchIndex.clear();
    this.root.subscribers.clear();
    this.root.forwarders.clear();
    this.branchIndex.set(this.relayId, this.root);

    // Assign all subscribers to root
    for (const subId of targetSet) {
      if (subId === this.relayId) continue;
      const node = this.dht.nodeMap.get(subId);
      if (!node?.alive) continue;
      this.root.subscribers.add(subId);
      this.subIndex.set(subId, this.root);
    }
    this.root.lastActive = this.tick;

    // Recursively delegate overflow
    this._delegateOverflow(this.root);
  }

  /**
   * While a tree node exceeds capacity, find the gateway synapse that
   * covers the most subscribers, create a forwarder there, and move
   * those subscribers to it.  Repeat until under capacity or no more
   * candidates.
   */
  _delegateOverflow(treeNode) {
    while (treeNode.fanOut > this.capacity) {
      const node = this.dht.nodeMap.get(treeNode.nodeId);
      if (!node?.alive) break;

      // Group current subscribers by their first-hop gateway
      const gateways = new Map();   // gatewayId → [subscriberId, ...]
      for (const subId of treeNode.subscribers) {
        const gw = this._firstHop(node, subId);
        if (gw == null) continue;                         // node itself is closest
        if (gw === treeNode.nodeId) continue;             // shouldn't happen, but guard
        if (treeNode.forwarders.has(gw)) continue;        // already a forwarder
        if (this.branchIndex.has(gw)) continue;           // already used elsewhere in tree
        let list = gateways.get(gw);
        if (!list) { list = []; gateways.set(gw, list); }
        list.push(subId);
      }

      // Find the gateway with the most subscribers
      let bestGw = null, bestList = [], bestCount = 0;
      for (const [gw, list] of gateways) {
        if (list.length > bestCount) {
          bestGw = gw;
          bestList = list;
          bestCount = list.length;
        }
      }

      // Need at least 2 subscribers to justify a forwarder
      if (!bestGw || bestCount < 2) break;

      // Create forwarder
      const forwarder = new TreeNode(bestGw, treeNode, treeNode.depth + 1);
      forwarder.lastActive = this.tick;
      treeNode.forwarders.set(bestGw, forwarder);
      this.branchIndex.set(bestGw, forwarder);

      // Move subscribers from parent to forwarder
      for (const subId of bestList) {
        treeNode.subscribers.delete(subId);
        forwarder.subscribers.add(subId);
        this.subIndex.set(subId, forwarder);
      }

      // Recursively delegate overflow at the new forwarder
      this._delegateOverflow(forwarder);
    }
  }

  /**
   * Find the first-hop synapse for greedy XOR routing from `node` toward
   * `targetId`.  Returns the synapse peerId, or null if the node itself
   * is the closest known peer to the target.
   */
  _firstHop(node, targetId) {
    let bestId   = null;
    let bestDist = node.id ^ targetId;   // distance from this node

    for (const syn of node.synaptome.values()) {
      const peer = this.dht.nodeMap.get(syn.peerId);
      if (!peer?.alive) continue;
      const dist = syn.peerId ^ targetId;
      if (dist < bestDist) {
        bestDist = dist;
        bestId   = syn.peerId;
      }
    }

    return bestId;   // null ⇒ node itself is closest
  }

  /**
   * Check if the subscriber set has changed since last build.
   */
  _subscribersChanged(targetSet) {
    if (targetSet.size !== this.subIndex.size) return true;
    for (const subId of targetSet) {
      if (!this.subIndex.has(subId)) return true;
    }
    return false;
  }

  // ── Tree Delivery ──────────────────────────────────────────────────────────

  /**
   * Deliver messages through the tree.
   * - Tree node → forwarder: 1 hop (direct synapse, just roundTripLatency)
   * - Tree node → subscriber: DHT lookup (but from a closer starting point)
   */
  async _deliverFrom(treeNode, pathHops, pathMs, hops, times, nodeLookups) {
    const node = this.dht.nodeMap.get(treeNode.nodeId);
    if (!node?.alive) return;

    // ── Send to forwarders (1 hop each — direct synapse) ──────────────────
    for (const [fwdId, forwarder] of treeNode.forwarders) {
      const fwdNode = this.dht.nodeMap.get(fwdId);
      if (!fwdNode?.alive) {
        // Forwarder died — fall back to direct delivery of its subscribers
        await this._fallbackDeliver(treeNode, forwarder, pathHops, pathMs, hops, times, nodeLookups);
        continue;
      }

      nodeLookups.set(treeNode.nodeId, (nodeLookups.get(treeNode.nodeId) ?? 0) + 1);
      const latMs = roundTripLatency(node, fwdNode);

      // Recurse: 1 hop to reach forwarder, then forwarder delivers its subtree
      await this._deliverFrom(forwarder, pathHops + 1, pathMs + latMs, hops, times, nodeLookups);
    }

    // ── DHT lookup to leaf subscribers ────────────────────────────────────
    for (const subId of treeNode.subscribers) {
      const subNode = this.dht.nodeMap.get(subId);
      if (!subNode?.alive) continue;

      nodeLookups.set(treeNode.nodeId, (nodeLookups.get(treeNode.nodeId) ?? 0) + 1);
      try {
        const r = await this.dht.lookup(treeNode.nodeId, subId);
        if (r?.found) {
          hops.push(pathHops + r.hops);
          times.push(Math.round(pathMs + r.time));
        }
      } catch { /* skip */ }
    }
  }

  /**
   * Fallback: a forwarder died, so its parent delivers to all subscribers
   * in the forwarder's subtree via DHT lookup.
   */
  async _fallbackDeliver(parent, deadForwarder, pathHops, pathMs, hops, times, nodeLookups) {
    const parentNode = this.dht.nodeMap.get(parent.nodeId);
    if (!parentNode?.alive) return;

    // Deliver to direct subscribers
    for (const subId of deadForwarder.subscribers) {
      const subNode = this.dht.nodeMap.get(subId);
      if (!subNode?.alive) continue;
      nodeLookups.set(parent.nodeId, (nodeLookups.get(parent.nodeId) ?? 0) + 1);
      try {
        const r = await this.dht.lookup(parent.nodeId, subId);
        if (r?.found) {
          hops.push(pathHops + r.hops);
          times.push(Math.round(pathMs + r.time));
        }
      } catch { /* skip */ }
    }

    // Recurse into dead forwarder's children
    for (const [, child] of deadForwarder.forwarders) {
      await this._fallbackDeliver(parent, child, pathHops, pathMs, hops, times, nodeLookups);
    }
  }

  // ── Maintenance ────────────────────────────────────────────────────────────

  _prune() {
    const cutoff = this.tick - this.ttl;

    // Prune dead/stale subscribers
    for (const [subId, branch] of this.subIndex) {
      const node = this.dht.nodeMap.get(subId);
      if (!node?.alive || branch.lastActive < cutoff) {
        branch.subscribers.delete(subId);
        this.subIndex.delete(subId);
        this._dirty = true;
      }
    }

    // Prune dead forwarders (heal: move their subscribers up to parent)
    for (const [branchId, branch] of this.branchIndex) {
      if (branchId === this.relayId) continue;
      const node = this.dht.nodeMap.get(branchId);
      if (!node?.alive) {
        this._healBranch(branch);
        this._dirty = true;
      }
    }

    // Collapse empty forwarders
    for (const [branchId, branch] of this.branchIndex) {
      if (branchId === this.relayId) continue;
      if (branch.subscribers.size === 0 && branch.forwarders.size === 0) {
        this._removeBranch(branch);
      }
    }
  }

  /**
   * Heal a dead forwarder: move its subscribers and children up to parent.
   */
  _healBranch(branch) {
    const parent = branch.parent;
    if (!parent) return;

    // Move subscribers up
    for (const subId of branch.subscribers) {
      parent.subscribers.add(subId);
      this.subIndex.set(subId, parent);
    }

    // Move child forwarders up
    for (const [childId, child] of branch.forwarders) {
      child.parent = parent;
      child.depth  = parent.depth + 1;
      parent.forwarders.set(childId, child);
      this._updateDepths(child);
    }

    this._removeBranch(branch);
  }

  _removeBranch(branch) {
    if (branch.parent) branch.parent.forwarders.delete(branch.nodeId);
    this.branchIndex.delete(branch.nodeId);
  }

  _updateDepths(branch) {
    for (const [, child] of branch.forwarders) {
      child.depth = branch.depth + 1;
      this._updateDepths(child);
    }
  }
}
