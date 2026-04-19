/**
 * test_axon.js — AxonManager (Phase 3a) membership protocol tests.
 *
 *   1. First subscribe → terminal node becomes root for the topic
 *   2. Non-root nodes forward subscribe (no role created)
 *   3. Multiple subscribers attach to the same root
 *   4. Renewal: re-subscribing bumps lastRenewed on existing child
 *   5. Publish routed by publisher → axon fans out to all children
 *   6. Publisher is not a child: still routes toward hash, axon delivers
 *   7. Self-subscribe + self-publish: local delivery via axon fan-out
 *   8. Unsubscribe removes the child from the axon's role
 *   9. TTL sweep drops children whose lastRenewed is too old
 *  10. Refresh keeps a subscription alive past the TTL window
 *  11. Empty non-root axon is GCed on next sweep (even though no recruitment in 3a)
 *  12. Empty root persists for rootGraceMs before GC
 *  13. refreshTick() re-issues subscribes for all mySubscriptions
 */

import { MockDHTNetwork } from './MockDHTNode.js';
import { AxonManager } from './AxonManager.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
const results = [];
function assert(name, cond, detail = '') {
  if (cond) { passed++; results.push(`  ✓ ${name}`); }
  else      { failed++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

/**
 * Build a network of nodes, each with an AxonManager attached.
 * Returns { net, nodes, axons } where axons[i] drives nodes[i].
 */
function buildAxonNetwork(n, opts = {}) {
  // Use a routing table that sees every peer so all subscribers converge
  // on the true closest-to-hash terminal. A realistic partial-mesh
  // routing table is studied under Phase 3c (churn + routing quality).
  const netOpts = { routingTableSize: n - 1, ...(opts.network || {}) };
  const net = new MockDHTNetwork(netOpts);
  const nodes = [];
  const axons = [];
  for (let i = 0; i < n; i++) {
    const node = net.createNode();
    nodes.push(node);
  }
  net.rebuildRoutingTables();
  // Attach an axon manager to each node AFTER the routing tables are built
  // so the handler registration lands on the finished topology.
  for (const node of nodes) {
    const axon = new AxonManager({
      dht: node,
      refreshIntervalMs:    opts.refreshIntervalMs    ?? 100000,   // tests drive manually
      maxSubscriptionAgeMs: opts.maxSubscriptionAgeMs ?? 30000,
      rootGraceMs:          opts.rootGraceMs          ?? 60000,
      now:                  opts.now || (() => Date.now()),
    });
    axons.push(axon);
  }
  return { net, nodes, axons };
}

/** Helper: find the axon for topicId — i.e., the one that holds its role. */
function findRootFor(axons, topicId) {
  return axons.find(a => a.axonRoles.has(topicId));
}

async function run() {
  // ── Test 1: Subscribe → root created at terminal ────────────────────
  {
    console.log('\n[Test 1] First subscribe creates root at terminal node');
    const topicId = 'aaaaaaaaaaaaaaaa';
    const { nodes, axons } = buildAxonNetwork(15);

    axons[0].pubsubSubscribe(topicId);
    await sleep(200);   // let the routed subscribe walk the network

    const roots = axons.filter(a => a.axonRoles.has(topicId));
    assert('exactly one root for the topic', roots.length === 1);
    const root = roots[0];
    const role = root.axonRoles.get(topicId);
    assert('root is marked isRoot', role.isRoot === true);
    assert('root has subscriber in children', role.children.has(nodes[0].id));
    assert('child has timestamps',
           role.children.get(nodes[0].id).createdAt > 0 &&
           role.children.get(nodes[0].id).lastRenewed > 0);
  }

  // ── Test 2: Intermediate hops do not create roles ────────────────────
  {
    console.log('\n[Test 2] Forwarding nodes do not create roles');
    const topicId = 'bbbbbbbbbbbbbbbb';
    const { axons } = buildAxonNetwork(20);

    axons[0].pubsubSubscribe(topicId);
    await sleep(200);

    const holders = axons.filter(a => a.axonRoles.has(topicId));
    assert('only one node holds the role', holders.length === 1);
  }

  // ── Test 3: Multiple subscribers attach to same root ─────────────────
  {
    console.log('\n[Test 3] Multiple subscribers attach to same root');
    const topicId = 'cccccccccccccccc';
    const { nodes, axons } = buildAxonNetwork(20);

    for (let i = 0; i < 5; i++) axons[i].pubsubSubscribe(topicId);
    await sleep(300);

    const root = findRootFor(axons, topicId);
    assert('root exists', !!root);
    assert('root has all 5 subscribers', root.axonRoles.get(topicId).children.size === 5);
    for (let i = 0; i < 5; i++) {
      assert(`child ${i} recorded`,
             root.axonRoles.get(topicId).children.has(nodes[i].id));
    }
  }

  // ── Test 4: Renewal bumps lastRenewed ────────────────────────────────
  {
    console.log('\n[Test 4] Re-subscribe bumps lastRenewed');
    let t = 1000;
    const now = () => t;
    const topicId = 'dddddddddddddddd';
    const { nodes, axons } = buildAxonNetwork(10, { now });

    axons[0].pubsubSubscribe(topicId);
    await sleep(100);
    const root = findRootFor(axons, topicId);
    const initial = root.axonRoles.get(topicId).children.get(nodes[0].id).lastRenewed;

    t = 5000;
    axons[0].pubsubSubscribe(topicId);   // renewal
    await sleep(100);
    const bumped  = root.axonRoles.get(topicId).children.get(nodes[0].id).lastRenewed;

    assert('lastRenewed bumped', bumped > initial);
    assert('still only one subscriber entry', root.axonRoles.get(topicId).children.size === 1);
  }

  // ── Test 5: Publish fans out ─────────────────────────────────────────
  {
    console.log('\n[Test 5] Publish routed toward topic hash, axon fans out');
    const topicId = 'eeeeeeeeeeeeeeee';
    const { axons } = buildAxonNetwork(20);

    const received = new Map();
    for (let i = 0; i < 5; i++) {
      axons[i].onPubsubDelivery((tid, json) => {
        if (!received.has(i)) received.set(i, []);
        received.get(i).push({ tid, json });
      });
      axons[i].pubsubSubscribe(topicId);
    }
    await sleep(300);

    // Publisher is a separate node (index 10 — not a subscriber).
    axons[10].pubsubPublish(topicId, JSON.stringify({ hello: 'world' }));
    await sleep(300);

    // All 5 subscribers should have received it exactly once.
    for (let i = 0; i < 5; i++) {
      const list = received.get(i) || [];
      assert(`subscriber ${i} received exactly 1 message`, list.length === 1,
             `got ${list.length}`);
      if (list.length > 0) {
        const parsed = JSON.parse(list[0].json);
        assert(`subscriber ${i} received correct data`, parsed.hello === 'world');
      }
    }
  }

  // ── Test 6: Non-subscriber publisher works ───────────────────────────
  {
    console.log('\n[Test 6] Publisher is not a subscriber — still works');
    const topicId = 'ffffffffffffffff';
    const { axons } = buildAxonNetwork(15);

    let fired = 0;
    axons[0].onPubsubDelivery(() => fired++);
    axons[0].pubsubSubscribe(topicId);
    await sleep(150);

    axons[5].pubsubPublish(topicId, '{"x":1}');
    await sleep(200);
    assert('non-subscriber publish reaches subscriber', fired === 1);
  }

  // ── Test 7: Publisher is also a subscriber (local delivery) ──────────
  {
    console.log('\n[Test 7] Publisher is also a subscriber — local delivery');
    const topicId = '1111111111111111';
    const { axons } = buildAxonNetwork(15);

    let selfFired = 0;
    axons[0].onPubsubDelivery(() => selfFired++);
    axons[0].pubsubSubscribe(topicId);
    await sleep(150);

    axons[0].pubsubPublish(topicId, '{"y":2}');
    await sleep(200);

    // The adapter layer normally filters self-delivery via senderId match,
    // but the axon itself should still produce one delivery callback at
    // the subscriber/publisher node. (At the adapter level it would be
    // filtered; at the raw axon level we see it.)
    assert('self-publish triggers delivery at self',
           selfFired === 1, `fired=${selfFired}`);
  }

  // ── Test 8: Unsubscribe removes the child ────────────────────────────
  {
    console.log('\n[Test 8] Unsubscribe removes child from role');
    const topicId = '2222222222222222';
    const { nodes, axons } = buildAxonNetwork(15);

    axons[0].pubsubSubscribe(topicId);
    axons[1].pubsubSubscribe(topicId);
    await sleep(200);

    const root = findRootFor(axons, topicId);
    assert('2 subscribers before unsubscribe',
           root.axonRoles.get(topicId).children.size === 2);

    axons[0].pubsubUnsubscribe(topicId);
    await sleep(200);

    assert('1 subscriber after unsubscribe',
           root.axonRoles.get(topicId).children.size === 1);
    assert('remaining subscriber is correct',
           root.axonRoles.get(topicId).children.has(nodes[1].id));
  }

  // ── Test 9: TTL sweep drops stale children ───────────────────────────
  {
    console.log('\n[Test 9] TTL sweep drops children whose lastRenewed is too old');
    let t = 1000;
    const now = () => t;
    const topicId = '3333333333333333';
    const { axons } = buildAxonNetwork(10, {
      now, maxSubscriptionAgeMs: 1000,
    });

    axons[0].pubsubSubscribe(topicId);
    await sleep(150);
    const root = findRootFor(axons, topicId);
    assert('subscribed before TTL sweep',
           root.axonRoles.get(topicId).children.size === 1);

    // Advance clock past TTL. Tick the sweep manually.
    t = 3000;
    root.refreshTick();
    assert('stale subscriber swept',
           root.axonRoles.get(topicId).children.size === 0);
  }

  // ── Test 10: Refresh keeps subscription alive ────────────────────────
  {
    console.log('\n[Test 10] Refresh keeps subscription alive past TTL');
    let t = 1000;
    const now = () => t;
    const topicId = '4444444444444444';
    const { axons } = buildAxonNetwork(10, {
      now, maxSubscriptionAgeMs: 1000,
    });

    axons[0].pubsubSubscribe(topicId);
    await sleep(150);
    const root = findRootFor(axons, topicId);

    // Advance clock 800ms (within TTL). Refresh the subscriber's leaf.
    t = 1800;
    axons[0].refreshTick();    // re-issues subscribe via mySubscriptions
    await sleep(150);

    // Advance clock another 800ms (now 1600ms since original sub, but
    // only 800ms since refresh). Sweep.
    t = 2600;
    root.refreshTick();
    assert('refreshed subscriber survives',
           root.axonRoles.get(topicId).children.size === 1);

    // Simulate the subscriber going silent (no more leaf-refresh). This is
    // different from unsubscribe (which would explicitly notify the axon);
    // we model the browser tab closing without a clean goodbye. Without
    // this step the test is flaky: if axons[0] happens to be the terminal
    // for this topic hash then it IS the root, and its own refreshTick
    // would bump the child's lastRenewed before the sweep ran.
    axons[0].mySubscriptions.delete(topicId);

    // Advance past TTL without further refresh.
    t = 4000;
    root.refreshTick();
    assert('unrefreshed subscriber expires',
           root.axonRoles.get(topicId).children.size === 0);
  }

  // ── Test 11: Empty non-root axon GC ──────────────────────────────────
  //    Phase 3a has no recruitment, so every axon is a root by normal
  //    flow. We inject a synthetic non-root role directly (simulating
  //    the state Phase 3b will create) and drive the expiry + GC path.
  {
    console.log('\n[Test 11] Empty non-root role is GCed on sweep');
    let t = 1000;
    const now = () => t;
    const topicId = '5555555555555555';
    const { nodes, axons } = buildAxonNetwork(5, { now, maxSubscriptionAgeMs: 500 });

    // Inject a synthetic non-root role that is already empty. The guard
    // we added to refreshTick (skip axon-refresh when children.size==0)
    // plus the GC step together should remove the empty role in one
    // tick, which is what the Phase 3b orderly-collapse machinery will
    // rely on in production flow.
    const target = axons[2];
    target.axonRoles.set(topicId, {
      parentId:       nodes[0].id,
      isRoot:         false,
      children:       new Map(),      // empty
      parentLastSent: 0,
      roleCreatedAt:  0,
      emptiedAt:      0,
    });

    t = 2000;
    target.refreshTick();
    assert('non-root empty role removed', !target.axonRoles.has(topicId));
  }

  // ── Test 12: Empty root grace period ─────────────────────────────────
  {
    console.log('\n[Test 12] Empty root persists for rootGraceMs');
    let t = 1000;
    const now = () => t;
    const topicId = '6666666666666666';
    const { axons } = buildAxonNetwork(5, {
      now, rootGraceMs: 5000, maxSubscriptionAgeMs: 60000,
    });

    axons[0].pubsubSubscribe(topicId);
    await sleep(100);
    const root = findRootFor(axons, topicId);
    assert('root exists', !!root);

    // Unsubscribe the only subscriber.
    axons[0].pubsubUnsubscribe(topicId);
    await sleep(100);
    assert('children empty', root.axonRoles.get(topicId).children.size === 0);
    assert('emptiedAt was set', root.axonRoles.get(topicId).emptiedAt > 0);

    // Advance clock 3 seconds — within grace period. Root should persist.
    t = 4000;
    root.refreshTick();
    assert('root persists within grace', root.axonRoles.has(topicId));

    // Advance past grace. Root should dissolve.
    t = 10000;
    root.refreshTick();
    assert('root dissolves past grace', !root.axonRoles.has(topicId));
  }

  // ── Test 13: refreshTick re-issues subscribes ────────────────────────
  {
    console.log('\n[Test 13] refreshTick re-issues subscribes for all mySubscriptions');
    let t = 1000;
    const now = () => t;
    const topicId = '7777777777777777';
    const { axons } = buildAxonNetwork(10, { now });

    axons[0].pubsubSubscribe(topicId);
    await sleep(150);
    const root = findRootFor(axons, topicId);
    const initial = [...root.axonRoles.get(topicId).children.values()][0].lastRenewed;

    // Advance clock and tick refresh. The re-subscribe should update lastRenewed.
    t = 5000;
    axons[0].refreshTick();
    await sleep(150);

    const bumped = [...root.axonRoles.get(topicId).children.values()][0].lastRenewed;
    assert('lastRenewed bumped by refreshTick', bumped > initial,
           `initial=${initial} bumped=${bumped}`);
  }

  // ── Summary ─────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  results.forEach(r => console.log(r));
  console.log('='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(err => { console.error(err); process.exit(1); });
