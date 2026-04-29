/**
 * Slice World partition: prune cross-hemisphere connections, leaving a
 * single bridge node that connects East and West.
 *
 * Hemisphere rule: Western = lng < 0, Eastern = lng >= 0.
 * The bridge node is exempt — it keeps all connections to both sides.
 *
 * This is an *adversarial* topology test: cross-hemisphere lookups must
 * find the bridge to succeed. Protocols without iterative fallback or
 * incoming-synapse reverse indexing typically fail to discover it.
 *
 * v0.67.03 — extracted from main.js so the simulation engine can apply
 * it as part of a benchmark test type, not just an interactive UI flow.
 */

/**
 * Pick the alive node geographically closest to (lat, lng). Used by the
 * benchmark engine to find a Hawaii-equivalent bridge in any pre-built
 * network. Returns the node, not the id.
 */
export function findNodeNearest(dht, lat, lng) {
  const alive = dht.getNodes().filter(n => n.alive);
  let best = null, bestDist = Infinity;
  for (const n of alive) {
    const dLat = n.lat - lat;
    const dLng = n.lng - lng;
    const d = dLat * dLat + dLng * dLng;
    if (d < bestDist) { bestDist = d; best = n; }
  }
  return best;
}

/**
 * Apply Slice World partition to an existing DHT. Removes every
 * cross-hemisphere edge except those incident on `bridgeId`. Works on
 * both NeuronNode-based protocols (synaptome / incomingSynapses /
 * highway) and KademliaNode-based ones (buckets / incomingPeers).
 */
export function applySliceWorldPartition(dht, bridgeId) {
  const isWestern = (node) => node.lng < 0;

  for (const node of dht.nodeMap.values()) {
    if (!node.alive || node.id === bridgeId) continue;
    const nodeWest = isWestern(node);

    if (node.synaptome) {
      // ── NeuronNode (neuromorphic protocols) ──
      for (const [peerId] of node.synaptome) {
        if (peerId === bridgeId) continue;
        const peer = dht.nodeMap.get(peerId);
        if (peer && isWestern(peer) !== nodeWest) {
          node.synaptome.delete(peerId);
        }
      }
      if (node.highway) {
        for (const [peerId] of node.highway) {
          if (peerId === bridgeId) continue;
          const peer = dht.nodeMap.get(peerId);
          if (peer && isWestern(peer) !== nodeWest) {
            node.highway.delete(peerId);
          }
        }
      }
      for (const [peerId] of node.incomingSynapses) {
        if (peerId === bridgeId) continue;
        const peer = dht.nodeMap.get(peerId);
        if (peer && isWestern(peer) !== nodeWest) {
          node.incomingSynapses.delete(peerId);
        }
      }
    } else if (node.buckets) {
      // ── KademliaNode (Kademlia / G-DHT) ──
      for (const bucket of node.buckets) {
        bucket.nodes = bucket.nodes.filter(peer =>
          peer.id === bridgeId || isWestern(peer) === nodeWest
        );
      }
      node._totalConns = node.buckets.reduce((s, b) => s + b.size, 0);
      if (node.incomingPeers) {
        for (const [peerId, peer] of node.incomingPeers) {
          if (peerId === bridgeId) continue;
          if (isWestern(peer) !== nodeWest) node.incomingPeers.delete(peerId);
        }
      }
    }
  }
}
