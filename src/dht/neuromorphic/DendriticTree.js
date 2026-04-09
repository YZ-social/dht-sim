/**
 * DendriticTree — Hierarchical relay tree for scalable pub/sub broadcast.
 *
 * Named for biological dendrites: the tree branches outward from a root relay
 * node toward subscribers.  Each branch node handles at most `capacity` direct
 * subscribers.  When a branch overflows, it recruits a new branch from its DHT
 * node's synaptome and delegates a subset of subscribers to it.
 *
 * The tree grows as subscribers are added and shrinks as subscriptions time out
 * or nodes die.  Dead branch nodes are healed by promoting their subscribers
 * back to the parent.
 *
 * Used by NX-7's pubsubBroadcast() to replace the flat relay→subscriber fan-out
 * with a distributed tree delivery.
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

// ── Dendritic Tree ─────────────────────────────────────────────────────────────

export class DendriticTree {
  /**
   * @param {object}  dht       — DHT instance (for nodeMap and lookup)
   * @param {bigint}  relayId   — root relay node ID
   * @param {number}  capacity  — max direct subscribers per branch (default 8)
   * @param {number}  maxDepth  — max tree depth (default 6)
   * @param {number}  ttl       — ticks before pruning inactive subscriber (default 10)
   */
  constructor(dht, relayId, { capacity = 8, ttl = 10 } = {}) {
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

  /** Mean fan-out (children + direct subscribers) per branch node. */
  get meanFanout() {
    let total = 0;
    for (const b of this.branchIndex.values()) {
      total += b.children.size + b.subscribers.size;
    }
    return this.branchIndex.size > 0 ? total / this.branchIndex.size : 0;
  }

  // ── Subscription Management ────────────────────────────────────────────────

  /**
   * Add a subscriber to the tree, or renew an existing subscription.
   * If the subscriber is new, walk the tree to find the best branch and attach.
   * If the receiving branch overflows capacity, split it.
   */
  addSubscriber(subscriberId) {
    // Renewal: subscriber already in tree
    const existing = this.subIndex.get(subscriberId);
    if (existing) {
      existing.lastActive = this.tick;
      return;
    }

    // Don't subscribe the relay itself
    if (subscriberId === this.root.nodeId) return;
    // Don't subscribe a node that's already a branch
    if (this.branchIndex.has(subscriberId)) return;

    // Walk tree to find best branch for this subscriber
    const branch = this._findBranch(this.root, subscriberId);
    branch.subscribers.add(subscriberId);
    branch.lastActive = this.tick;
    this.subIndex.set(subscriberId, branch);

    // Split if over capacity
    if (branch.subscribers.size > this.capacity) {
      this._split(branch);
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
    // Collapse empty branches upward
    this._collapseIfEmpty(branch);
  }

  /**
   * Prune subscribers not renewed within TTL ticks, and dead nodes.
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
    // Prune dead branch nodes — promote their subscribers to parent
    for (const [branchId, branch] of this.branchIndex) {
      if (branchId === this.root.nodeId) continue;  // root handled separately
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
   * Returns per-subscriber hop counts and latencies (cumulative from root).
   *
   * @param {Set<bigint>} targetSet — set of subscriber IDs to deliver to
   *                                   (used for renewal tracking)
   * @returns {{ hops: number[], times: number[], maxNodeLookups: number }}
   */
  async broadcast(targetSet) {
    this.tick++;

    // Add/renew all targets
    for (const subId of targetSet) {
      this.addSubscriber(subId);
    }

    // Deliver through tree, tracking per-node lookup counts
    const hops  = [];
    const times = [];
    const nodeLookups = new Map();   // branchNodeId → number of lookups performed
    await this._deliverFrom(this.root, 0, 0, hops, times, nodeLookups);

    // Prune expired/dead
    this.prune();

    // Max fan-out: most lookups performed by any single node
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

  // ── Tree Construction Internals ────────────────────────────────────────────

  /**
   * Walk the tree to find the best branch for a new subscriber.
   * At each level, descend into the child whose DHT ID is XOR-closest
   * to the subscriber, but only if it's closer than the current branch.
   */
  _findBranch(branch, subscriberId) {
    if (branch.children.size === 0) return branch;

    let bestChild = null;
    let bestDist  = null;

    for (const [childId, child] of branch.children) {
      // Skip dead children
      if (!this.dht.nodeMap.get(childId)?.alive) continue;
      const dist = childId ^ subscriberId;
      if (bestDist === null || dist < bestDist) {
        bestDist  = dist;
        bestChild = child;
      }
    }

    // Only descend if child is genuinely closer to subscriber than current branch
    if (bestChild) {
      const currentDist = branch.nodeId ^ subscriberId;
      if (bestDist < currentDist) {
        return this._findBranch(bestChild, subscriberId);
      }
    }

    return branch;
  }

  /**
   * Split an overloaded branch by recruiting a new branch node from
   * the DHT node's synaptome.  The new branch takes at least 25% of
   * the parent's subscribers — those XOR-closest to the candidate.
   */
  _split(branch) {
    const dhtNode = this.dht.nodeMap.get(branch.nodeId);
    if (!dhtNode?.alive) return;

    const subs = [...branch.subscribers];
    const minMove = Math.max(2, Math.ceil(subs.length * 0.25));

    // Score each synapse as a potential branch candidate
    let bestCandidate = null;
    let bestCount     = 0;

    for (const syn of dhtNode.synaptome.values()) {
      const peer = this.dht.nodeMap.get(syn.peerId);
      if (!peer?.alive) continue;
      if (this.branchIndex.has(syn.peerId)) continue;   // already a branch
      if (this.subIndex.has(syn.peerId)) continue;       // is a subscriber

      // Count subscribers closer to this candidate than to branch
      let count = 0;
      for (const subId of subs) {
        if ((syn.peerId ^ subId) < (branch.nodeId ^ subId)) count++;
      }
      if (count > bestCount) {
        bestCount     = count;
        bestCandidate = syn.peerId;
      }
    }

    // Candidate must attract at least 25% of subscribers
    if (!bestCandidate || bestCount < minMove) return;

    // Create new branch
    const newBranch    = new BranchNode(bestCandidate, branch, branch.depth + 1);
    newBranch.lastActive = this.tick;

    // Sort subscribers by distance to candidate (closest first)
    // and move at least 25% — all that are closer to candidate than to branch
    const scored = subs.map(subId => ({
      subId,
      distCandidate: bestCandidate ^ subId,
      distBranch:    branch.nodeId ^ subId,
    }));
    scored.sort((a, b) => {
      // Primary: closer to candidate relative to branch
      const aRatio = a.distCandidate < a.distBranch ? -1 : 1;
      const bRatio = b.distCandidate < b.distBranch ? -1 : 1;
      if (aRatio !== bRatio) return aRatio - bRatio;
      // Tiebreak: absolute distance to candidate
      return a.distCandidate < b.distCandidate ? -1 : 1;
    });

    // Move all that are genuinely closer, but at least minMove
    let moved = 0;
    for (const { subId, distCandidate, distBranch } of scored) {
      if (moved >= minMove && distCandidate >= distBranch) break;
      branch.subscribers.delete(subId);
      newBranch.subscribers.add(subId);
      this.subIndex.set(subId, newBranch);
      moved++;
    }

    branch.children.set(bestCandidate, newBranch);
    this.branchIndex.set(bestCandidate, newBranch);

    // Recursive split if new branch is also over capacity
    if (newBranch.subscribers.size > this.capacity) {
      this._split(newBranch);
    }
  }

  // ── Tree Maintenance ───────────────────────────────────────────────────────

  /**
   * Heal a dead branch: promote all its subscribers and children to its parent.
   */
  _healBranch(branch) {
    const parent = branch.parent;
    if (!parent) return;  // root died — can't heal (caller must rebuild tree)

    // Move subscribers up to parent
    for (const subId of branch.subscribers) {
      parent.subscribers.add(subId);
      this.subIndex.set(subId, parent);
    }

    // Move children up to parent
    for (const [childId, child] of branch.children) {
      child.parent = parent;
      child.depth  = parent.depth + 1;
      parent.children.set(childId, child);
      // Recursively update depth of descendants
      this._updateDepths(child);
    }

    // Remove dead branch
    this._removeBranch(branch);
  }

  /**
   * Remove a branch from the tree (detach from parent, remove from index).
   */
  _removeBranch(branch) {
    if (branch.parent) {
      branch.parent.children.delete(branch.nodeId);
    }
    this.branchIndex.delete(branch.nodeId);
  }

  /**
   * Collapse a branch upward if it has no subscribers and no children.
   */
  _collapseIfEmpty(branch) {
    if (branch === this.root) return;
    if (branch.subscribers.size === 0 && branch.children.size === 0) {
      this._removeBranch(branch);
    }
  }

  /**
   * Recursively update depth values after a subtree is re-parented.
   */
  _updateDepths(branch) {
    for (const [, child] of branch.children) {
      child.depth = branch.depth + 1;
      this._updateDepths(child);
    }
  }

  // ── Tree Delivery ──────────────────────────────────────────────────────────

  /**
   * Recursively deliver from a branch node, accumulating per-subscriber
   * hop counts and latencies.  pathHops/pathMs track the cumulative cost
   * from root to the current branch.
   */
  async _deliverFrom(branch, pathHops, pathMs, hops, times, nodeLookups) {
    const branchNode = this.dht.nodeMap.get(branch.nodeId);
    if (!branchNode?.alive) return;  // dead branch — healed during prune()

    // Deliver to child branches (branch → child routing cost)
    for (const [childId, child] of branch.children) {
      const childNode = this.dht.nodeMap.get(childId);
      if (!childNode?.alive) continue;  // will be healed during prune()

      nodeLookups.set(branch.nodeId, (nodeLookups.get(branch.nodeId) ?? 0) + 1);
      const r = await this.dht.lookup(branch.nodeId, childId);
      if (r?.found) {
        await this._deliverFrom(child, pathHops + r.hops, pathMs + r.time, hops, times, nodeLookups);
      } else {
        // Couldn't reach child branch — deliver its subscribers directly
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

  /**
   * Fallback: deliver a child branch's entire subtree directly from the parent.
   * Used when the parent can't reach the child branch node.
   */
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
