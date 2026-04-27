import { roundTripLatency } from '../utils/geo.js';

/**
 * SimulatedNetwork – implements message passing without real network I/O.
 *
 * Latency is computed geometrically (great-circle distance) rather than
 * waited on, making the simulation run at full CPU speed.
 *
 * To convert this into a real network:
 *   - Replace `send()` with an async TCP/UDP call to the target node.
 *   - Replace `computeLatency()` with measured RTT.
 *   - Keep the same interface so DHTNode / DHT subclasses need zero changes.
 */
export class SimulatedNetwork {
  constructor(dht = null) {
    /** @type {Map<number, import('./DHTNode.js').DHTNode>} */
    this.nodes = new Map();
    this.messageCount = 0;
    /**
     * Back-reference to the owning DHT so we can propagate connection-cap
     * invariants to every node that registers, including those added long
     * after `buildRoutingTables` has already run (churn replacements,
     * interactive Add Nodes, slice-world bridges, etc.).
     */
    this.dht = dht;
  }

  /**
   * Register a node, attach this network to it, and inherit the DHT-wide
   * connection cap (set by buildRoutingTables). This is the single chokepoint
   * where the bilateral-cap invariant gets stamped onto every node — no
   * subclass can forget to do it because every subclass calls this method.
   */
  addNode(node) {
    this.nodes.set(node.id, node);
    node._network = this;
    if (this.dht && isFinite(this.dht.maxConnections)) {
      node.maxConnections = this.dht.maxConnections;
    }
  }

  /** Mark a node as dead and remove it from the registry. */
  removeNode(nodeId) {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.alive = false;
      node._network = null;
      this.nodes.delete(nodeId);
    }
  }

  /**
   * Simulate sending a message from `fromNode` to `toNodeId`.
   * Calls `handleMessage` on the target node synchronously (no real I/O).
   *
   * @returns {{ response: any, latency: number }}   latency in ms (round-trip)
   */
  send(fromNode, toNodeId, type, data) {
    const toNode = this.nodes.get(toNodeId);
    if (!toNode || !toNode.alive) {
      throw new Error(`Node ${toNodeId} is unreachable`);
    }

    this.messageCount++;
    const latency = roundTripLatency(fromNode, toNode);
    const response = toNode.handleMessage({ type, from: fromNode.id, data });
    return { response, latency };
  }

  /** One-way latency for analytics (used by lookup algorithms). */
  computeLatency(fromNode, toNode) {
    return roundTripLatency(fromNode, toNode);
  }

  get size() {
    return this.nodes.size;
  }
}
