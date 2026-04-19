/**
 * AxonManager — distributed pub/sub membership protocol.
 *
 * Implements the PubSubAdapter transport contract on top of a DHT that
 * provides the routed-messaging primitives (routeMessage, onRoutedMessage,
 * sendDirect, onDirectMessage).
 *
 * This is Phase 3a: core membership with timestamped children, periodic
 * refresh, and TTL-based expiry. No sub-axon recruitment — a single axon
 * per topic holds every subscriber. Phase 3b introduces recruitment and
 * orderly collapse; Phase 3c adds explicit churn recovery.
 *
 * Message types (over the DHT):
 *
 *   ROUTED:
 *     pubsub:subscribe   — payload: { topicId, subscriberId }
 *     pubsub:unsubscribe — payload: { topicId, subscriberId }
 *     pubsub:publish     — payload: { topicId, json }
 *
 *   DIRECT:
 *     pubsub:deliver     — payload: { topicId, json }
 *
 * See documents/Phase3-Membership-Protocol-Plan.md for the full design
 * rationale, state model, and parameter defaults.
 */

// ── Defaults (simulator-tuned; production would use much longer values) ────

const DEFAULT_MAX_DIRECT_SUBS        = 20;           // §5.8 hysteresis (unused in 3a)
const DEFAULT_MIN_DIRECT_SUBS        = 5;            // §5.8 hysteresis (unused in 3a)
const DEFAULT_REFRESH_INTERVAL_MS    = 10_000;       // §5.5
const DEFAULT_MAX_SUBSCRIPTION_AGE_MS = 30_000;      // §5.7 — 3× refresh
const DEFAULT_ROOT_GRACE_MS          = 60_000;       // §5.7 — 6× refresh

// ── AxonManager ────────────────────────────────────────────────────────────

export class AxonManager {
  /**
   * @param {Object} opts
   * @param {MockDHTNode} opts.dht     — the DHT primitive (routeMessage etc.)
   * @param {number} [opts.maxDirectSubs]
   * @param {number} [opts.minDirectSubs]
   * @param {number} [opts.refreshIntervalMs]
   * @param {number} [opts.maxSubscriptionAgeMs]
   * @param {number} [opts.rootGraceMs]
   * @param {Function} [opts.now]      — clock (for deterministic testing)
   */
  constructor({
    dht,
    maxDirectSubs        = DEFAULT_MAX_DIRECT_SUBS,
    minDirectSubs        = DEFAULT_MIN_DIRECT_SUBS,
    refreshIntervalMs    = DEFAULT_REFRESH_INTERVAL_MS,
    maxSubscriptionAgeMs = DEFAULT_MAX_SUBSCRIPTION_AGE_MS,
    rootGraceMs          = DEFAULT_ROOT_GRACE_MS,
    now                  = () => Date.now(),
  } = {}) {
    if (!dht) throw Error('AxonManager: dht is required');

    this.dht                   = dht;
    this.nodeId                = dht.getSelfId();
    this.maxDirectSubs         = maxDirectSubs;
    this.minDirectSubs         = minDirectSubs;
    this.refreshIntervalMs     = refreshIntervalMs;
    this.maxSubscriptionAgeMs  = maxSubscriptionAgeMs;
    this.rootGraceMs           = rootGraceMs;
    this._now                  = now;

    /** topicHash -> TopicRole */
    this.axonRoles = new Map();

    /** topicHash -> TopicSub (my own subscription state — only if I called subscribe) */
    this.mySubscriptions = new Map();

    /** Delivery callback — registered by PubSubAdapter via onPubsubDelivery. */
    this._deliveryCallback = null;

    // Register handlers with the DHT.
    dht.onRoutedMessage('pubsub:subscribe',   (p, m) => this._onSubscribe(p, m));
    dht.onRoutedMessage('pubsub:unsubscribe', (p, m) => this._onUnsubscribe(p, m));
    dht.onRoutedMessage('pubsub:publish',     (p, m) => this._onPublish(p, m));
    dht.onDirectMessage('pubsub:deliver',     (p, m) => this._onDeliver(p, m));

    // Periodic refresh + TTL sweep. We use a single timer driving both
    // actions; refreshTick() is exported for tests that prefer to pump
    // the state machine manually rather than rely on wall-clock timers.
    this._timer = null;
  }

  /** Start the periodic refresh/sweep timer. Idempotent. */
  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this.refreshTick(), this.refreshIntervalMs);
  }

  /** Stop the periodic timer. */
  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  // ── PubSubAdapter transport contract ────────────────────────────────

  pubsubPublish(topicId, json) {
    this.dht.routeMessage(topicId, 'pubsub:publish', { topicId, json });
  }

  pubsubSubscribe(topicId) {
    // Track our own subscription so refreshTick() can renew it.
    this.mySubscriptions.set(topicId, { subscribedAt: this._now() });
    this.dht.routeMessage(topicId, 'pubsub:subscribe',
                          { topicId, subscriberId: this.nodeId });
  }

  pubsubUnsubscribe(topicId) {
    this.mySubscriptions.delete(topicId);
    this.dht.routeMessage(topicId, 'pubsub:unsubscribe',
                          { topicId, subscriberId: this.nodeId });
  }

  onPubsubDelivery(callback) {
    this._deliveryCallback = callback;
  }

  // ── Handlers ────────────────────────────────────────────────────────

  /**
   * SUBSCRIBE routed message handler.
   *
   * - If we are already the axon for topicId: add/renew the subscriber.
   * - If we are the terminal (closest-to-hash) and no axon exists: become root.
   * - Otherwise: forward along the route.
   */
  _onSubscribe(payload, meta) {
    const { topicId, subscriberId } = payload;
    const role = this.axonRoles.get(topicId);
    const now = this._now();

    if (role) {
      const existing = role.children.get(subscriberId);
      if (existing) {
        existing.lastRenewed = now;
      } else {
        // Phase 3a: no recruitment; every subscriber attaches directly.
        role.children.set(subscriberId, { createdAt: now, lastRenewed: now });
      }
      return 'consumed';
    }

    if (meta.isTerminal) {
      // Become the root for this topic.
      this.axonRoles.set(topicId, {
        parentId:       null,
        isRoot:         true,
        children:       new Map([[subscriberId, { createdAt: now, lastRenewed: now }]]),
        parentLastSent: 0,
        roleCreatedAt:  now,
        emptiedAt:      0,   // tracks when children last went empty — §5.7 rootGrace
      });
      return 'consumed';
    }

    return 'forward';
  }

  /**
   * UNSUBSCRIBE routed message handler.
   *
   * If we are the axon holding this subscriber, drop them from children.
   * We do NOT eagerly dissolve an emptied non-root axon — that is handled
   * by §5.7 TTL sweep (or §5.8 hysteresis in Phase 3b). This keeps
   * unsubscribe semantics uniform with TTL expiry and avoids flapping on
   * rapid subscribe/unsubscribe churn.
   */
  _onUnsubscribe(payload, meta) {
    const { topicId, subscriberId } = payload;
    const role = this.axonRoles.get(topicId);
    if (role && role.children.has(subscriberId)) {
      role.children.delete(subscriberId);
      if (role.children.size === 0) role.emptiedAt = this._now();
      return 'consumed';
    }
    return 'forward';
  }

  /**
   * PUBLISH routed message handler.
   *
   * If we are the axon for this topic, fan out to all children via
   * sendDirect. Otherwise, forward along the route.
   */
  _onPublish(payload, meta) {
    const { topicId, json } = payload;
    const role = this.axonRoles.get(topicId);
    if (!role) return 'forward';

    // Note: we deliberately do NOT skip the peer that forwarded the publish
    // to us. A forwarder is a relay, not a recipient — if they happen to
    // also be a subscriber, they need delivery. The PubSubAdapter's own
    // senderId-based drop handles the publisher's own self-delivery.
    for (const [childId] of role.children) {
      if (childId === this.nodeId) {
        // We're both axon and subscriber — deliver locally (no network).
        if (this._deliveryCallback) this._deliveryCallback(topicId, json);
        continue;
      }
      this.dht.sendDirect(childId, 'pubsub:deliver', { topicId, json });
    }
    return 'consumed';
  }

  /**
   * DIRECT delivery handler — fires when an axon fan-out reaches us.
   */
  _onDeliver(payload, meta) {
    const { topicId, json } = payload;
    if (this._deliveryCallback) this._deliveryCallback(topicId, json);
  }

  // ── Refresh and TTL sweep ───────────────────────────────────────────

  /**
   * One tick of the maintenance loop:
   *   1. Renew each of our own subscriptions (leaf refresh).
   *   2. Renew our axon memberships upward to parents (axon refresh).
   *      Phase 3a: single-axon-per-topic, so isRoot is the only branch.
   *   3. Sweep expired children from each axonRole.
   *   4. GC empty non-root roles. GC empty roots past rootGraceMs.
   *
   * Exposed publicly so tests can drive the state machine deterministically.
   */
  refreshTick() {
    const now = this._now();

    // 1. Leaf refresh — re-issue each of our own subscribes.
    for (const topicId of this.mySubscriptions.keys()) {
      this.dht.routeMessage(topicId, 'pubsub:subscribe',
                            { topicId, subscriberId: this.nodeId });
    }

    // 2. Axon refresh — a non-root axon must refresh upward so its parent
    //    does not TTL-drop it. Phase 3a has no recruitment so all axons
    //    are roots; this block is a no-op here but the plumbing is in
    //    place for Phase 3b.
    //    An axon with no children has no reason to stay in the tree;
    //    skip the refresh and let the GC step remove it.
    for (const [topicId, role] of this.axonRoles) {
      if (role.isRoot) continue;
      if (role.children.size === 0) continue;
      this.dht.routeMessage(topicId, 'pubsub:subscribe',
                            { topicId, subscriberId: this.nodeId });
      role.parentLastSent = now;
    }

    // 3. TTL sweep — drop stale children.
    for (const role of this.axonRoles.values()) {
      for (const [childId, entry] of role.children) {
        if (now - entry.lastRenewed > this.maxSubscriptionAgeMs) {
          role.children.delete(childId);
        }
      }
      if (role.children.size === 0 && role.emptiedAt === 0) {
        role.emptiedAt = now;
      }
    }

    // 4. GC empty roles.
    for (const [topicId, role] of this.axonRoles) {
      if (role.children.size > 0) continue;
      if (!role.isRoot) {
        // Non-root empty: dissolve immediately (TTL-driven collapse — no
        // outbound message needed; parent's next sweep will drop us).
        this.axonRoles.delete(topicId);
        continue;
      }
      // Root empty: respect rootGrace.
      if (role.emptiedAt > 0 && now - role.emptiedAt > this.rootGraceMs) {
        this.axonRoles.delete(topicId);
      }
    }
  }

  // ── Diagnostics ─────────────────────────────────────────────────────

  /** Snapshot for tests: list of (topicId, role) with serializable children. */
  inspectRoles() {
    const out = [];
    for (const [topicId, role] of this.axonRoles) {
      out.push({
        topicId,
        isRoot:         role.isRoot,
        parentId:       role.parentId,
        roleCreatedAt:  role.roleCreatedAt,
        emptiedAt:      role.emptiedAt,
        children: [...role.children.entries()].map(([id, e]) => ({
          id, createdAt: e.createdAt, lastRenewed: e.lastRenewed,
        })),
      });
    }
    return out;
  }

  /** Clean shutdown — stop the timer. Does not send unsubscribes; use
   *  pubsubUnsubscribe explicitly for a graceful departure. */
  destroy() {
    this.stop();
    this.axonRoles.clear();
    this.mySubscriptions.clear();
    this._deliveryCallback = null;
  }
}
