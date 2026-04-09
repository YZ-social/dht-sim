/**
 * DendriticTreeV3 — Geographic-clustered relay tree for scalable pub/sub.
 *
 * Exploits the S2 geographic prefix in node IDs.  Nodes in the same S2 cell
 * share the top GEO_BITS (default 8) of their ID and already have intra-cell
 * synapses from bootstrap.
 *
 * Construction (bottom-up):
 *   1. Group subscribers by S2 cell prefix
 *   2. For each cell group, recruit a branch node from the same cell
 *   3. If a cell group exceeds capacity, subdivide by additional ID bits
 *   4. Connect all cell branches to root
 *
 * Delivery:
 *   - Root → branch: standard DHT lookup (cross-cell, ~3 hops)
 *   - Branch → subscriber: DIRECT 1-hop delivery (same cell, known subscriber)
 *     No DHT lookup needed — branch knows its subscriber list and they share
 *     the same geographic cell, so latency is just roundTripLatency.
 *
 * Used by NX-9's pubsubBroadcast().
 */

import { roundTripLatency } from '../../utils/geo.js';

// ── Branch Node ────────────────────────────────────────────────────────────────

class BranchNode {
  constructor(nodeId, parent = null, depth = 0) {
    this.nodeId      = nodeId;
    this.parent      = parent;
    this.depth       = depth;
    this.children    = new Map();       // nodeId → BranchNode
    this.subscribers = new Set();       // leaf subscriber nodeIds
    this.lastActive  = 0;
  }

  get subtreeSize() {
    let n = this.subscribers.size;
    for (const child of this.children.values()) n += child.subtreeSize;
    return n;
  }
}

// ── Dendritic Tree V3 (Geographic) ─────────────────────────────────────────────

export class DendriticTreeV3 {
  /**
   * @param {object}  dht       — DHT instance
   * @param {bigint}  relayId   — root relay node ID
   * @param {number}  capacity  — max subscribers per leaf branch (default 32)
   * @param {number}  geoBits   — S2 prefix bits in node IDs (default 8)
   * @param {number}  ttl       — ticks before pruning inactive subscriber
   */
  constructor(dht, relayId, { capacity = 32, geoBits = 8, ttl = 10 } = {}) {
    this.dht         = dht;
    this.relayId     = relayId;
    this.root        = new BranchNode(relayId, null, 0);
    this.capacity    = capacity;
    this.geoBits     = geoBits;
    this.ttl         = ttl;
    this.tick        = 0;
    this._dirty      = true;     // tree needs rebuild

    /** subscriberId → BranchNode */
    this.subIndex    = new Map();
    /** branchNodeId → BranchNode */
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

  // ── Tree Construction (Bottom-Up Geographic Clustering) ────────────────────

  /**
   * Build the tree from scratch by grouping subscribers by S2 cell prefix.
   */
  _buildTree(targetSet) {
    // Clear old tree (keep root)
    this.subIndex.clear();
    this.branchIndex.clear();
    this.root.children.clear();
    this.root.subscribers.clear();
    this.branchIndex.set(this.relayId, this.root);

    // Group subscribers by S2 cell prefix
    const cellShift = BigInt(64 - this.geoBits);
    const cellGroups = new Map();  // cellPrefix → [subscriberId, ...]

    for (const subId of targetSet) {
      if (subId === this.relayId) continue;
      const node = this.dht.nodeMap.get(subId);
      if (!node?.alive) continue;

      const cell = subId >> cellShift;
      let group = cellGroups.get(cell);
      if (!group) { group = []; cellGroups.set(cell, group); }
      group.push(subId);
    }

    // For each cell group, create a branch
    for (const [cell, subscribers] of cellGroups) {
      if (subscribers.length === 0) continue;

      // Find branch candidate: a node in this cell that isn't a subscriber
      const branchId = this._findCellBranch(cell, cellShift, subscribers);

      if (branchId && branchId !== this.relayId) {
        const branch = new BranchNode(branchId, this.root, 1);
        branch.lastActive = this.tick;
        this.root.children.set(branchId, branch);
        this.branchIndex.set(branchId, branch);

        // Assign subscribers to this branch
        for (const subId of subscribers) {
          branch.subscribers.add(subId);
          this.subIndex.set(subId, branch);
        }

        // If cell group exceeds capacity, subdivide
        if (branch.subscribers.size > this.capacity) {
          this._subdivideBranch(branch, this.geoBits);
        }
      } else {
        // No suitable branch in this cell — assign directly to root
        for (const subId of subscribers) {
          this.root.subscribers.add(subId);
          this.subIndex.set(subId, this.root);
        }
      }
    }
  }

  /**
   * Find a branch node within the given S2 cell.  Prefer a node that has
   * synapses pointing to subscribers in this cell (i.e., can reach them).
   */
  _findCellBranch(cell, cellShift, subscribers) {
    const subSet = new Set(subscribers);

    // Look through nodeMap for nodes in this cell
    // Prefer nodes with the most synapses pointing to our subscribers
    let bestId    = null;
    let bestScore = -1;

    // First, check the root's synaptome — these are reachable from root
    const rootNode = this.dht.nodeMap.get(this.relayId);
    if (rootNode?.alive) {
      for (const syn of rootNode.synaptome.values()) {
        const peer = this.dht.nodeMap.get(syn.peerId);
        if (!peer?.alive) continue;
        if (subSet.has(syn.peerId)) continue;
        if ((syn.peerId >> cellShift) !== cell) continue;

        // Score: how many subscribers does this peer have synapses to?
        let score = 0;
        for (const s of peer.synaptome.values()) {
          if (subSet.has(s.peerId)) score++;
        }
        // Bonus for being reachable from root
        score += 2;
        if (score > bestScore) {
          bestScore = score;
          bestId    = syn.peerId;
        }
      }
    }

    // Also check subscribers' neighbors — nodes they can reach
    // (sample a few subscribers to keep it fast)
    const sampleSize = Math.min(subscribers.length, 8);
    for (let i = 0; i < sampleSize; i++) {
      const subNode = this.dht.nodeMap.get(subscribers[i]);
      if (!subNode?.alive) continue;
      for (const syn of subNode.synaptome.values()) {
        const peer = this.dht.nodeMap.get(syn.peerId);
        if (!peer?.alive) continue;
        if (subSet.has(syn.peerId)) continue;
        if (this.branchIndex.has(syn.peerId)) continue;
        if ((syn.peerId >> cellShift) !== cell) continue;

        let score = 0;
        for (const s of peer.synaptome.values()) {
          if (subSet.has(s.peerId)) score++;
        }
        if (score > bestScore) {
          bestScore = score;
          bestId    = syn.peerId;
        }
      }
    }

    return bestId;
  }

  /**
   * Subdivide a branch whose cell group exceeds capacity.
   * Split by additional ID bits beyond geoBits.
   */
  _subdivideBranch(branch, bitsUsed) {
    const subs = [...branch.subscribers];
    if (subs.length <= this.capacity) return;

    // Split by the next bit after the current prefix depth
    const splitBit = BigInt(63 - bitsUsed);  // next bit position (0-indexed from MSB)
    if (splitBit < 0n) return;  // exhausted bits

    const group0 = [];  // bit = 0
    const group1 = [];  // bit = 1
    for (const subId of subs) {
      if ((subId >> splitBit) & 1n) {
        group1.push(subId);
      } else {
        group0.push(subId);
      }
    }

    // Only split if both sides have subscribers
    if (group0.length === 0 || group1.length === 0) {
      // Try next bit
      this._subdivideBranch(branch, bitsUsed + 1);
      return;
    }

    // Find branch candidates for each sub-group
    const cellShift = BigInt(64 - bitsUsed - 1);
    const cand0 = this._findSubBranch(branch, group0);
    const cand1 = this._findSubBranch(branch, group1);

    if (cand0 && cand1 && cand0 !== cand1) {
      // Create two child branches
      const branch0 = new BranchNode(cand0, branch, branch.depth + 1);
      const branch1 = new BranchNode(cand1, branch, branch.depth + 1);
      branch0.lastActive = this.tick;
      branch1.lastActive = this.tick;

      // Move subscribers
      for (const subId of group0) {
        branch.subscribers.delete(subId);
        branch0.subscribers.add(subId);
        this.subIndex.set(subId, branch0);
      }
      for (const subId of group1) {
        branch.subscribers.delete(subId);
        branch1.subscribers.add(subId);
        this.subIndex.set(subId, branch1);
      }

      branch.children.set(cand0, branch0);
      branch.children.set(cand1, branch1);
      this.branchIndex.set(cand0, branch0);
      this.branchIndex.set(cand1, branch1);

      // Recursively subdivide if still over capacity
      if (branch0.subscribers.size > this.capacity) {
        this._subdivideBranch(branch0, bitsUsed + 1);
      }
      if (branch1.subscribers.size > this.capacity) {
        this._subdivideBranch(branch1, bitsUsed + 1);
      }
    } else {
      // Can't find two candidates — try next bit
      this._subdivideBranch(branch, bitsUsed + 1);
    }
  }

  /**
   * Find a branch candidate near a sub-group of subscribers.
   */
  _findSubBranch(parentBranch, subscribers) {
    const subSet = new Set(subscribers);

    // Check parent branch node's synaptome
    const parentNode = this.dht.nodeMap.get(parentBranch.nodeId);
    if (!parentNode?.alive) return null;

    let bestId = null;
    let bestScore = -1;

    for (const syn of parentNode.synaptome.values()) {
      const peer = this.dht.nodeMap.get(syn.peerId);
      if (!peer?.alive) continue;
      if (subSet.has(syn.peerId)) continue;
      if (this.branchIndex.has(syn.peerId)) continue;

      let score = 0;
      for (const s of peer.synaptome.values()) {
        if (subSet.has(s.peerId)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestId = syn.peerId;
      }
    }

    return bestId;
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
   * - Branch → child branch: DHT lookup (cross-cell routing)
   * - Leaf branch → subscriber: DIRECT 1-hop delivery (same geographic cell)
   */
  async _deliverFrom(branch, pathHops, pathMs, hops, times, nodeLookups) {
    const branchNode = this.dht.nodeMap.get(branch.nodeId);
    if (!branchNode?.alive) return;

    // Route to child branches via DHT lookup
    for (const [childId, child] of branch.children) {
      const childNode = this.dht.nodeMap.get(childId);
      if (!childNode?.alive) continue;

      nodeLookups.set(branch.nodeId, (nodeLookups.get(branch.nodeId) ?? 0) + 1);
      const r = await this.dht.lookup(branch.nodeId, childId);
      if (r?.found) {
        await this._deliverFrom(child, pathHops + r.hops, pathMs + r.time, hops, times, nodeLookups);
      } else {
        // Fallback: deliver child's subscribers directly from parent
        await this._deliverDirectly(branch, child, pathHops, pathMs, hops, times, nodeLookups);
      }
    }

    // Direct 1-hop delivery to leaf subscribers (same geographic cell)
    for (const subId of branch.subscribers) {
      const subNode = this.dht.nodeMap.get(subId);
      if (!subNode?.alive) continue;

      nodeLookups.set(branch.nodeId, (nodeLookups.get(branch.nodeId) ?? 0) + 1);
      const latMs = roundTripLatency(branchNode, subNode);
      hops.push(pathHops + 1);           // 1 hop: direct delivery
      times.push(Math.round(pathMs + latMs));
    }
  }

  async _deliverDirectly(parent, branch, pathHops, pathMs, hops, times, nodeLookups) {
    const parentNode = this.dht.nodeMap.get(parent.nodeId);
    if (!parentNode?.alive) return;

    for (const subId of branch.subscribers) {
      const subNode = this.dht.nodeMap.get(subId);
      if (!subNode?.alive) continue;
      nodeLookups.set(parent.nodeId, (nodeLookups.get(parent.nodeId) ?? 0) + 1);
      const r = await this.dht.lookup(parent.nodeId, subId);
      if (r?.found) {
        hops.push(pathHops + r.hops);
        times.push(Math.round(pathMs + r.time));
      }
    }
    for (const [, child] of branch.children) {
      await this._deliverDirectly(parent, child, pathHops, pathMs, hops, times, nodeLookups);
    }
  }

  // ── Maintenance ────────────────────────────────────────────────────────────

  _prune() {
    const cutoff = this.tick - this.ttl;
    for (const [subId, branch] of this.subIndex) {
      const node = this.dht.nodeMap.get(subId);
      if (!node?.alive || branch.lastActive < cutoff) {
        branch.subscribers.delete(subId);
        this.subIndex.delete(subId);
        this._dirty = true;
      }
    }
    for (const [branchId, branch] of this.branchIndex) {
      if (branchId === this.relayId) continue;
      const node = this.dht.nodeMap.get(branchId);
      if (!node?.alive) {
        this._healBranch(branch);
        this._dirty = true;
      }
    }
    // Collapse empty branches
    for (const [branchId, branch] of this.branchIndex) {
      if (branchId === this.relayId) continue;
      if (branch.subscribers.size === 0 && branch.children.size === 0) {
        this._removeBranch(branch);
      }
    }
  }

  _healBranch(branch) {
    const parent = branch.parent;
    if (!parent) return;
    for (const subId of branch.subscribers) {
      parent.subscribers.add(subId);
      this.subIndex.set(subId, parent);
    }
    for (const [childId, child] of branch.children) {
      child.parent = parent;
      child.depth  = parent.depth + 1;
      parent.children.set(childId, child);
      this._updateDepths(child);
    }
    this._removeBranch(branch);
  }

  _removeBranch(branch) {
    if (branch.parent) branch.parent.children.delete(branch.nodeId);
    this.branchIndex.delete(branch.nodeId);
  }

  _updateDepths(branch) {
    for (const [, child] of branch.children) {
      child.depth = branch.depth + 1;
      this._updateDepths(child);
    }
  }
}
