/**
 * DendriticTreeV2 — Balanced binary relay tree for scalable pub/sub broadcast.
 *
 * Differs from DendriticTree (V1, NX-7) in split strategy:
 *   V1: Peels 25% off to a single new branch → tall, sparse trees
 *   V2: Binary 50/50 split → parent becomes pure relay, ALL subscribers
 *       move to two new child branches.  Produces balanced trees with
 *       depth ≈ log₂(N/capacity).
 *
 * The tree is dynamic:
 *   - GROWS as subscribers are added (binary split when branch exceeds capacity)
 *   - SHRINKS as subscriptions time out or nodes die (prunes empty branches)
 *   - SELF-HEALS when branch nodes die (subscribers promoted to parent)
 *
 * Used by NX-8's pubsubBroadcast().
 */

// ── Branch Node ────────────────────────────────────────────────────────────────

class BranchNode {
  constructor(nodeId, parent = null, depth = 0) {
    this.nodeId      = nodeId;          // DHT node ID serving as this branch
    this.parent      = parent;          // parent BranchNode (null for root)
    this.depth       = depth;           // level in tree (root = 0)
    this.children    = new Map();       // nodeId → BranchNode (branch children)
    this.subscribers = new Set();       // leaf subscriber nodeIds
    this.lastActive  = 0;              // tick of last renewal
  }

  /** Total subscribers in this subtree (direct + all descendants). */
  get subtreeSize() {
    let n = this.subscribers.size;
    for (const child of this.children.values()) n += child.subtreeSize;
    return n;
  }
}

// ── Dendritic Tree V2 ──────────────────────────────────────────────────────────

export class DendriticTreeV2 {
  /**
   * @param {object}  dht       — DHT instance (for nodeMap and lookup)
   * @param {bigint}  relayId   — root relay node ID
   * @param {number}  capacity  — max direct subscribers per branch (default 32)
   * @param {number}  ttl       — ticks before pruning inactive subscriber (default 10)
   */
  constructor(dht, relayId, { capacity = 32, ttl = 10 } = {}) {
    this.dht         = dht;
    this.root        = new BranchNode(relayId, null, 0);
    this.capacity    = capacity;
    this.ttl         = ttl;
    this.tick        = 0;

    /** subscriberId → BranchNode that directly serves it */
    this.subIndex    = new Map();
    /** branchNodeId → BranchNode */
    this.branchIndex = new Map();
    this.branchIndex.set(relayId, this.root);
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** Number of branch (interior) nodes in the tree, including root. */
  get branchCount() { return this.branchIndex.size; }

  /** Max depth of the tree. */
  get depth() {
    let max = 0;
    for (const b of this.branchIndex.values()) {
      if (b.depth > max) max = b.depth;
    }
    return max;
  }

  // ── Subscription Management ────────────────────────────────────────────────

  /**
   * Add a subscriber to the tree, or renew an existing subscription.
   */
  addSubscriber(subscriberId) {
    // Renewal
    const existing = this.subIndex.get(subscriberId);
    if (existing) {
      existing.lastActive = this.tick;
      return;
    }

    // Don't subscribe the relay itself or existing branches
    if (subscriberId === this.root.nodeId) return;
    if (this.branchIndex.has(subscriberId)) return;

    // Walk tree to find best leaf branch
    const branch = this._findBranch(this.root, subscriberId);
    branch.subscribers.add(subscriberId);
    branch.lastActive = this.tick;
    this.subIndex.set(subscriberId, branch);

    // Binary split if over capacity
    if (branch.subscribers.size > this.capacity) {
      this._binarySplit(branch);
    }
  }

  /**
   * Remove a subscriber from the tree.
   */
  removeSubscriber(subscriberId) {
    const branch = this.subIndex.get(subscriberId);
    if (!branch) return;
    branch.subscribers.delete(subscriberId);
    this.subIndex.delete(subscriberId);
    this._collapseIfEmpty(branch);
  }

  /**
   * Prune dead/expired subscribers and heal dead branches.
   */
  prune() {
    const cutoff = this.tick - this.ttl;
    // Prune dead or expired subscribers
    for (const [subId, branch] of this.subIndex) {
      const node = this.dht.nodeMap.get(subId);
      if (!node?.alive || branch.lastActive < cutoff) {
        branch.subscribers.delete(subId);
        this.subIndex.delete(subId);
      }
    }
    // Heal dead branch nodes
    for (const [branchId, branch] of this.branchIndex) {
      if (branchId === this.root.nodeId) continue;
      const node = this.dht.nodeMap.get(branchId);
      if (!node?.alive) {
        this._healBranch(branch);
      }
    }
    // Collapse empty branches
    for (const [branchId, branch] of this.branchIndex) {
      if (branchId === this.root.nodeId) continue;
      if (branch.subscribers.size === 0 && branch.children.size === 0) {
        this._removeBranch(branch);
      }
    }
  }

  // ── Broadcast Through Tree ─────────────────────────────────────────────────

  /**
   * Deliver a message from root through the tree to all subscribers.
   * @returns {{ hops: number[], times: number[], maxNodeLookups: number, treeDepth: number, avgSubsPerNode: number }}
   */
  async broadcast(targetSet) {
    this.tick++;

    // Add/renew all targets
    for (const subId of targetSet) {
      this.addSubscriber(subId);
    }

    // Deliver through tree
    const hops  = [];
    const times = [];
    const nodeLookups = new Map();
    await this._deliverFrom(this.root, 0, 0, hops, times, nodeLookups);

    // Prune expired/dead
    this.prune();

    // Max fan-out
    let maxNodeLookups = 0;
    for (const count of nodeLookups.values()) {
      if (count > maxNodeLookups) maxNodeLookups = count;
    }

    // Average subscribers per branch node
    const avgSubs = this.branchIndex.size > 0
      ? this.subIndex.size / this.branchIndex.size
      : 0;

    return { hops, times, maxNodeLookups, treeDepth: this.depth, avgSubsPerNode: avgSubs };
  }

  // ── Tree Construction ──────────────────────────────────────────────────────

  /**
   * Walk tree to find the best leaf branch for a subscriber.
   */
  _findBranch(branch, subscriberId) {
    if (branch.children.size === 0) return branch;

    let bestChild = null;
    let bestDist  = null;

    for (const [childId, child] of branch.children) {
      if (!this.dht.nodeMap.get(childId)?.alive) continue;
      const dist = childId ^ subscriberId;
      if (bestDist === null || dist < bestDist) {
        bestDist  = dist;
        bestChild = child;
      }
    }

    if (bestChild) {
      return this._findBranch(bestChild, subscriberId);
    }

    return branch;
  }

  /**
   * Binary 50/50 split: recruit TWO branch candidates from the synaptome,
   * divide ALL subscribers between them, and make the current node a pure relay.
   */
  _binarySplit(branch) {
    const dhtNode = this.dht.nodeMap.get(branch.nodeId);
    if (!dhtNode?.alive) return;

    const subs = [...branch.subscribers];
    if (subs.length <= this.capacity) return;

    // Find two best branch candidates from synaptome
    const candidates = this._findTwoCandidates(dhtNode, subs);
    if (!candidates) return;

    const [candA, candB] = candidates;

    // Create two new branches
    const branchA = new BranchNode(candA, branch, branch.depth + 1);
    const branchB = new BranchNode(candB, branch, branch.depth + 1);
    branchA.lastActive = this.tick;
    branchB.lastActive = this.tick;

    // Divide ALL subscribers: each goes to whichever candidate is XOR-closer
    for (const subId of subs) {
      branch.subscribers.delete(subId);
      const distA = candA ^ subId;
      const distB = candB ^ subId;
      if (distA <= distB) {
        branchA.subscribers.add(subId);
        this.subIndex.set(subId, branchA);
      } else {
        branchB.subscribers.add(subId);
        this.subIndex.set(subId, branchB);
      }
    }

    // Parent becomes pure relay (no direct subscribers)
    branch.children.set(candA, branchA);
    branch.children.set(candB, branchB);
    this.branchIndex.set(candA, branchA);
    this.branchIndex.set(candB, branchB);

    // Recursively split children if still over capacity
    if (branchA.subscribers.size > this.capacity) {
      this._binarySplit(branchA);
    }
    if (branchB.subscribers.size > this.capacity) {
      this._binarySplit(branchB);
    }
  }

  /**
   * Find two synapse candidates that best partition the subscriber set.
   * Strategy: find the candidate that attracts the most subscribers (candA),
   * then find a second candidate that attracts the most of the remainder (candB).
   * Returns [candA_id, candB_id] or null if can't find two candidates.
   */
  _findTwoCandidates(dhtNode, subs) {
    // Build eligible candidate list
    const eligible = [];
    for (const syn of dhtNode.synaptome.values()) {
      const peer = this.dht.nodeMap.get(syn.peerId);
      if (!peer?.alive) continue;
      if (this.branchIndex.has(syn.peerId)) continue;
      if (this.subIndex.has(syn.peerId)) continue;
      eligible.push(syn.peerId);
    }

    // Also check 2-hop neighborhood for more candidates
    for (const syn of dhtNode.synaptome.values()) {
      const hop1 = this.dht.nodeMap.get(syn.peerId);
      if (!hop1?.alive) continue;
      for (const s2 of hop1.synaptome.values()) {
        const hop2 = this.dht.nodeMap.get(s2.peerId);
        if (!hop2?.alive) continue;
        if (s2.peerId === dhtNode.id) continue;
        if (this.branchIndex.has(s2.peerId)) continue;
        if (this.subIndex.has(s2.peerId)) continue;
        if (eligible.includes(s2.peerId)) continue;
        eligible.push(s2.peerId);
        if (eligible.length >= 96) break;  // cap search
      }
      if (eligible.length >= 96) break;
    }

    if (eligible.length < 2) return null;

    // Find candA: attracts the most subscribers (XOR-closer than branch)
    let bestA = null;
    let bestACount = 0;
    const branchId = dhtNode.id;

    for (const candId of eligible) {
      let count = 0;
      for (const subId of subs) {
        if ((candId ^ subId) < (branchId ^ subId)) count++;
      }
      if (count > bestACount) {
        bestACount = count;
        bestA = candId;
      }
    }

    if (!bestA || bestACount < 2) return null;

    // Find candB: attracts the most subscribers that candA doesn't
    let bestB = null;
    let bestBCount = 0;

    for (const candId of eligible) {
      if (candId === bestA) continue;
      let count = 0;
      for (const subId of subs) {
        // Count subscribers closer to candB than to both candA and branch
        const distB = candId ^ subId;
        const distA = bestA ^ subId;
        if (distB < distA) count++;
      }
      if (count > bestBCount) {
        bestBCount = count;
        bestB = candId;
      }
    }

    if (!bestB || bestBCount < 2) return null;

    return [bestA, bestB];
  }

  // ── Tree Maintenance ───────────────────────────────────────────────────────

  /**
   * Heal a dead branch: promote its subscribers and children to parent.
   */
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
    if (branch.parent) {
      branch.parent.children.delete(branch.nodeId);
    }
    this.branchIndex.delete(branch.nodeId);
  }

  _collapseIfEmpty(branch) {
    if (branch === this.root) return;
    if (branch.subscribers.size === 0 && branch.children.size === 0) {
      this._removeBranch(branch);
    }
  }

  _updateDepths(branch) {
    for (const [, child] of branch.children) {
      child.depth = branch.depth + 1;
      this._updateDepths(child);
    }
  }

  // ── Tree Delivery ──────────────────────────────────────────────────────────

  async _deliverFrom(branch, pathHops, pathMs, hops, times, nodeLookups) {
    const branchNode = this.dht.nodeMap.get(branch.nodeId);
    if (!branchNode?.alive) return;

    // Deliver to child branches
    for (const [childId, child] of branch.children) {
      const childNode = this.dht.nodeMap.get(childId);
      if (!childNode?.alive) continue;

      nodeLookups.set(branch.nodeId, (nodeLookups.get(branch.nodeId) ?? 0) + 1);
      const r = await this.dht.lookup(branch.nodeId, childId);
      if (r?.found) {
        await this._deliverFrom(child, pathHops + r.hops, pathMs + r.time, hops, times, nodeLookups);
      } else {
        await this._deliverDirectly(branch, child, pathHops, pathMs, hops, times, nodeLookups);
      }
    }

    // Deliver to leaf subscribers
    for (const subId of branch.subscribers) {
      const subNode = this.dht.nodeMap.get(subId);
      if (!subNode?.alive) continue;

      nodeLookups.set(branch.nodeId, (nodeLookups.get(branch.nodeId) ?? 0) + 1);
      const r = await this.dht.lookup(branch.nodeId, subId);
      if (r?.found) {
        hops.push(pathHops + r.hops);
        times.push(Math.round(pathMs + r.time));
      }
    }
  }

  async _deliverDirectly(parent, branch, pathHops, pathMs, hops, times, nodeLookups) {
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
}
