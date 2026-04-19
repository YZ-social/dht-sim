/**
 * MockDHTTransport — a fake DHT that implements the PubSubAdapter transport
 * contract entirely in-process. Used to exercise adapter logic before we
 * wire to the real NX-10 Axonal tree in Phase 3.
 *
 * Design:
 *   - A shared MockNetwork object owns the subscriber registry (topicId →
 *     Set<nodeId>) and routes publishes by invoking each subscriber's
 *     onPubsubDelivery callback.
 *   - Each per-node MockDHTTransport instance registers itself with the
 *     network and exposes the contracted methods.
 *   - The network can inject latency, reordering, and drops — the adapter
 *     should survive all three under the tier-1 gap-detection semantics.
 */

export class MockNetwork {
  constructor({ defaultLatencyMs = 5 } = {}) {
    this.subscribers     = new Map();  // topicId -> Set<nodeId>
    this.transports      = new Map();  // nodeId -> MockDHTTransport
    this.defaultLatencyMs = defaultLatencyMs;

    // Behavioural injections for testing.
    this.latencyFn = () => this.defaultLatencyMs;  // override for jitter
    this.dropFn    = () => false;                  // override to drop payloads
    this.reorder   = false;                        // if true, randomize delivery order
  }

  register(transport) {
    this.transports.set(transport.nodeId, transport);
  }

  deregister(nodeId) {
    this.transports.delete(nodeId);
    for (const set of this.subscribers.values()) set.delete(nodeId);
  }

  addSubscriber(topicId, nodeId) {
    if (!this.subscribers.has(topicId)) this.subscribers.set(topicId, new Set());
    this.subscribers.get(topicId).add(nodeId);
  }

  removeSubscriber(topicId, nodeId) {
    const set = this.subscribers.get(topicId);
    if (!set) return;
    set.delete(nodeId);
    if (set.size === 0) this.subscribers.delete(topicId);
  }

  /**
   * Deliver `json` to every subscriber of `topicId` except the publisher.
   * Each recipient's transport fires its onPubsubDelivery callback.
   */
  publish(fromNodeId, topicId, json) {
    const set = this.subscribers.get(topicId);
    if (!set) return;

    const recipients = [...set].filter(id => id !== fromNodeId);
    const order = this.reorder ? this._shuffle(recipients) : recipients;

    for (const nodeId of order) {
      const transport = this.transports.get(nodeId);
      if (!transport) continue;
      if (this.dropFn(fromNodeId, nodeId, topicId)) continue;
      const latency = this.latencyFn(fromNodeId, nodeId, topicId);
      setTimeout(() => transport._deliver(topicId, json), latency);
    }
  }

  _shuffle(a) {
    const out = a.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}

export class MockDHTTransport {
  constructor(nodeId, network) {
    this.nodeId   = String(nodeId);
    this.network  = network;
    this._delivery = null;
    network.register(this);
  }

  // ── Adapter contract ─────────────────────────────────────────────────

  pubsubPublish(topicId, json) {
    this.network.publish(this.nodeId, topicId, json);
  }

  pubsubSubscribe(topicId) {
    this.network.addSubscriber(topicId, this.nodeId);
  }

  pubsubUnsubscribe(topicId) {
    this.network.removeSubscriber(topicId, this.nodeId);
  }

  onPubsubDelivery(callback) {
    this._delivery = callback;
  }

  // ── Internal (called by MockNetwork) ─────────────────────────────────

  _deliver(topicId, json) {
    if (this._delivery) this._delivery(topicId, json);
  }
}
