import { SimulatedNetwork } from './SimulatedNetwork.js';

/**
 * DHT – abstract base class for all DHT protocol implementations.
 *
 * Concrete subclasses (KademliaDHT, ChordDHT, etc.) override:
 *   - addNode(lat, lng)  → DHTNode
 *   - removeNode(nodeId)
 *   - lookup(sourceId, targetKey) → LookupResult
 *   - buildRoutingTables()
 *
 * The network layer (SimulatedNetwork) is swappable without touching subclasses.
 */
export class DHT {
  /**
   * @param {object} config - Protocol-specific configuration
   */
  constructor(config = {}) {
    this.config = config;
    this.network = new SimulatedNetwork();
  }

  /**
   * Add a new node at the given geographic coordinates.
   * @returns {Promise<import('./DHTNode.js').DHTNode>}
   */
  async addNode(lat, lng) {
    throw new Error(`${this.constructor.name}.addNode() not implemented`);
  }

  /**
   * Remove a node by ID (simulate churn: node leaving).
   */
  async removeNode(nodeId) {
    throw new Error(`${this.constructor.name}.removeNode() not implemented`);
  }

  /**
   * Perform a key lookup starting from the given source node.
   *
   * @param {number} sourceId  - Node ID of the initiating node
   * @param {number} targetKey - The key being looked up
   * @returns {Promise<LookupResult>}
   *
   * @typedef {object} LookupResult
   * @property {number[]} path    - Ordered list of node IDs visited
   * @property {number}   hops    - Number of nodes contacted (excl. source)
   * @property {number}   time    - Critical-path time in ms
   * @property {boolean}  found   - Whether a responsible node was found
   */
  async lookup(sourceId, targetKey) {
    throw new Error(`${this.constructor.name}.lookup() not implemented`);
  }

  /**
   * Rebuild routing tables after bulk node additions.
   * Optional: some implementations do this lazily.
   */
  buildRoutingTables({ bidirectional = true, maxConnections = Infinity } = {}) {
    this.bidirectional  = bidirectional;
    this.maxConnections = maxConnections;
  }

  /** Return all currently active nodes. */
  getNodes() {
    return [...this.network.nodes.values()];
  }

  /** Summary statistics about the current DHT state. */
  getStats() {
    const nodes = this.getNodes();
    return {
      totalNodes: nodes.length,
      aliveNodes: nodes.filter(n => n.alive).length,
      messageCount: this.network.messageCount,
    };
  }

  /**
   * Release all large object-graph references so the GC can collect this DHT
   * immediately after a benchmark protocol finishes — without waiting for the
   * next GC cycle to discover the circular references.
   *
   * Subclasses with additional large Maps (e.g. nodeMap) should override and
   * call super.dispose().
   */
  dispose() {
    // Neuromorphic nodes carry multiple Maps per node plus a _nodeMapRef
    // back-pointer, creating a circular reference graph that the GC must fully
    // trace before it can reclaim anything.  Explicitly clearing every per-node
    // collection before dropping the nodeMap breaks all cycles immediately so
    // memory is freed on the next minor GC rather than waiting for a full cycle.
    if (this.nodeMap instanceof Map) {
      for (const node of this.nodeMap.values()) {
        node.synaptome?.clear();
        node.incomingSynapses?.clear();
        node.highway?.clear();
        node.transitCache?.clear();
        node.regionalBaselines?.clear();
        node.recentDestFreq?.clear();
        node.pinWindowFreq?.clear();
        node.pinnedDests?.clear();
        if (node.recentDests)  node.recentDests.length  = 0;
        if (node.pinWindow)    node.pinWindow.length    = 0;
        node._nodeMapRef = null;  // break the circular back-reference
      }
      this.nodeMap.clear();
      this.nodeMap = null;
    }
    // Clear the network node registry.
    if (this.network) {
      this.network.nodes?.clear();
      this.network = null;
    }
  }

  /** Human-readable protocol name – used in UI. */
  static get protocolName() {
    return 'DHT';
  }
}
