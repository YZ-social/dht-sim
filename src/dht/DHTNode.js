/**
 * DHTNode – base class representing a physical node in the DHT network.
 *
 * Design intent: this class is network-agnostic. In simulation mode, the
 * SimulatedNetwork wires nodes together directly. In a real deployment, a
 * RealNetwork implementation would replace SimulatedNetwork, intercepting
 * send/receive at the same interface without touching this class.
 */
import { geoCellId } from '../utils/s2.js';

/**
 * Number of bits used for the S2 geographic cell stored on every node.
 * 8 bits → 256 cells worldwide, radius ≈ 800 km each – fine-grained enough
 * for the 2000 km regional radius while still being coarser than node IDs.
 */
export const GEO_CELL_BITS = 8;

export class DHTNode {
  /**
   * @param {object} opts
   * @param {number} opts.id    - Unique identifier in the DHT key space
   * @param {number} opts.lat   - Geographic latitude  (-90 … 90)
   * @param {number} opts.lng   - Geographic longitude (-180 … 180)
   */
  constructor({ id, lat, lng }) {
    this.id = id;
    this.lat = lat;
    this.lng = lng;
    this.alive = true;
    this.joinedAt = Date.now();

    /**
     * S2 geographic cell ID (GEO_CELL_BITS wide).
     * Computed for every node regardless of protocol so that regional lookups
     * can route by geographic cell XOR even in plain Kademlia.
     */
    this.s2Cell = geoCellId(lat, lng, GEO_CELL_BITS);

    // Injected by the DHT implementation
    this.routingTable = null;

    // Injected by the Network layer
    this._network = null;
  }

  /**
   * Handle an incoming message.  Implemented by subclasses (e.g. KademliaNode).
   * @param {{ type: string, from: number, data: any }} msg
   * @returns {any}
   */
  handleMessage(msg) {
    throw new Error(`${this.constructor.name}.handleMessage() not implemented`);
  }

  /**
   * Send a message to another node via the network layer.
   * Returns { response, latency } where latency is in ms.
   * In simulation this is synchronous + instant; latency is computed, not waited.
   *
   * @param {number}  targetId
   * @param {string}  type
   * @param {any}     data
   */
  async send(targetId, type, data) {
    if (!this._network) throw new Error('Node not connected to a network');
    return this._network.send(this, targetId, type, data);
  }

  toJSON() {
    return { id: this.id, lat: this.lat, lng: this.lng, alive: this.alive };
  }
}
