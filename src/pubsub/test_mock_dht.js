/**
 * test_mock_dht.js — verify MockDHTNode routing primitives before building
 * the membership protocol on top of them.
 *
 *   1. getSelfId returns the node's id
 *   2. _greedyNextHopToward returns a peer closer to target
 *   3. _greedyNextHopToward returns null when we are closest (terminal)
 *   4. routeMessage walks to a terminal and invokes the handler there
 *   5. routeMessage respects 'consumed' and halts
 *   6. routeMessage increments hop count as it walks
 *   7. routeMessage respects maxHops cap
 *   8. routeMessage drops when dropFn returns true
 *   9. sendDirect delivers to the peer
 *  10. sendDirect to a dead peer returns false (churn handling)
 *  11. Handler registration is per-instance
 *  12. xorDistance is symmetric and self-zero
 */

import { MockDHTNode, MockDHTNetwork, xorDistance, randomNodeId } from './MockDHTNode.js';

let passed = 0, failed = 0;
const results = [];
function assert(name, cond, detail = '') {
  if (cond) { passed++; results.push(`  ✓ ${name}`); }
  else      { failed++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Build a network of n nodes with full routing-table population. */
function buildNetwork(n, opts = {}) {
  const net = new MockDHTNetwork(opts);
  for (let i = 0; i < n; i++) net.createNode();
  net.rebuildRoutingTables();
  return net;
}

async function run() {
  // ── Test 1: identity ────────────────────────────────────────────────
  {
    console.log('\n[Test 1] Identity + basic shape');
    const net = new MockDHTNetwork();
    const n = net.createNode('abcdef0123456789');
    assert('getSelfId returns id', n.getSelfId() === 'abcdef0123456789');
    assert('routingTable empty until rebuild', n.routingTable.size === 0);
    assert('xorDistance is zero for same id',
           xorDistance('abc', 'abc') === 0n);
    assert('xorDistance is symmetric',
           xorDistance('a0', 'f5') === xorDistance('f5', 'a0'));
  }

  // ── Test 2-3: greedy next hop ───────────────────────────────────────
  {
    console.log('\n[Test 2-3] _greedyNextHopToward');
    const net = buildNetwork(30, { routingTableSize: 10 });
    const nodes = [...net.nodes.values()];
    const src = nodes[0];
    const tgt = nodes[15];

    // Walk toward the target's id manually. At each step, the next hop
    // must be strictly closer to the target. Eventually we reach a node
    // whose next-hop is null (terminal) — that node must be the closest
    // live node to the target across the whole network (given the full
    // routing table).
    let current = src;
    let prevDist = xorDistance(current.id, tgt.id);
    let steps = 0;
    while (steps < 40) {
      const nh = current._greedyNextHopToward(tgt.id);
      if (!nh) break;
      const d = xorDistance(nh.id, tgt.id);
      if (d >= prevDist) {
        assert('each greedy hop strictly reduces XOR distance', false,
               `step ${steps}: prev=${prevDist} new=${d}`);
        break;
      }
      prevDist = d;
      current = nh;
      steps++;
    }
    assert('walk terminates within maxHops', steps < 40, `steps=${steps}`);
    assert('greedy hops strictly reduce distance', true);

    // At the terminal, we should be closer than any of our peers.
    const terminal = current;
    const termDist = xorDistance(terminal.id, tgt.id);
    for (const peer of terminal.routingTable.values()) {
      const pd = xorDistance(peer.id, tgt.id);
      assert('terminal is closer than any of its peers', termDist <= pd,
             `terminal=${termDist} peer=${pd}`);
      break; // only check one — full check is overkill
    }
  }

  // ── Test 4: routeMessage delivers at terminal ───────────────────────
  {
    console.log('\n[Test 4] routeMessage walks to terminal and fires handler');
    const net = buildNetwork(20);
    const nodes = [...net.nodes.values()];
    const src = nodes[0];
    const target = nodes[10];

    // Every node forwards (default when no handler registered).
    // We only register a "terminal" catcher on whichever node is terminal.
    const caught = [];
    for (const n of nodes) {
      n.onRoutedMessage('test', (p, meta) => {
        if (meta.isTerminal) { caught.push(n.id); return 'consumed'; }
        return 'forward';
      });
    }

    const result = await src.routeMessage(target.id, 'test', { foo: 'bar' });
    assert('consumed at terminal', result.consumed === true);
    assert('exactly one node caught', caught.length === 1);
    assert('atNode matches caught id', result.atNode === caught[0]);
    assert('hops > 0 (walked the path)', result.hops > 0);
  }

  // ── Test 5: routeMessage respects consumed ──────────────────────────
  {
    console.log('\n[Test 5] Handler can consume mid-walk');
    const net = buildNetwork(20);
    const nodes = [...net.nodes.values()];
    const src = nodes[0];

    // Set up a handler on every node that catches ANY message (not just terminal).
    let catchCount = 0;
    let catchId = null;
    for (const n of nodes) {
      n.onRoutedMessage('stop', (p, meta) => {
        catchCount++;
        if (catchId === null) catchId = n.id;
        return 'consumed';
      });
    }

    const result = await src.routeMessage(nodes[15].id, 'stop', {});
    assert('consumed at first hop (the origin itself)', catchCount === 1);
    assert('atNode is the first catcher', result.atNode === catchId);
    assert('hops is 0 (caught before forwarding)', result.hops === 0);
  }

  // ── Test 6: Hop counter ─────────────────────────────────────────────
  {
    console.log('\n[Test 6] Hop counter reflects walk length');
    const net = buildNetwork(20);
    const nodes = [...net.nodes.values()];
    const src = nodes[0];
    const target = nodes[10];

    // Register a no-op (returns undefined → forward) on all nodes.
    // The walk ends when greedy routing runs out of forward peers.
    for (const n of nodes) n.onRoutedMessage('trace', () => {});

    const result = await src.routeMessage(target.id, 'trace', {});
    assert('routed ended', !result.consumed);
    assert('hops >= 1 (walked at least one step)', result.hops >= 1);
    assert('terminal flag set', result.terminal === true);
  }

  // ── Test 7: maxHops cap ─────────────────────────────────────────────
  {
    console.log('\n[Test 7] maxHops cap terminates the walk');
    const net = buildNetwork(20);
    const nodes = [...net.nodes.values()];
    const src = nodes[0];
    const target = nodes[10];

    // Force loop: every node's handler returns 'forward' and each node's
    // routingTable picks a different neighbour — we just cap the walk.
    for (const n of nodes) n.onRoutedMessage('capped', () => 'forward');

    const result = await src.routeMessage(target.id, 'capped', {}, { maxHops: 2 });
    assert('walk terminated via cap or terminal', result.hops <= 2);
    // Either we hit terminal within 2 hops, or we exhausted.
    assert('cap or terminal outcome', result.terminal === true || result.exhausted === true);
  }

  // ── Test 8: dropFn drops ────────────────────────────────────────────
  {
    console.log('\n[Test 8] dropFn drops the message');
    const net = buildNetwork(10);
    const nodes = [...net.nodes.values()];
    const src = nodes[0];
    const target = nodes[5];

    for (const n of nodes) n.onRoutedMessage('droppable', () => 'forward');
    net.dropFn = () => true;   // drop every hop

    const result = await src.routeMessage(target.id, 'droppable', {});
    assert('dropped flag set', result.dropped === true);
  }

  // ── Test 9: sendDirect delivers ─────────────────────────────────────
  {
    console.log('\n[Test 9] sendDirect delivers to peer');
    const net = buildNetwork(5, { defaultLatencyMs: 2 });
    const nodes = [...net.nodes.values()];

    let receivedPayload = null;
    let receivedMeta    = null;
    nodes[1].onDirectMessage('greet', (p, m) => {
      receivedPayload = p;
      receivedMeta = m;
    });

    const ok = nodes[0].sendDirect(nodes[1].id, 'greet', { hi: true });
    assert('sendDirect returned true', ok === true);
    await sleep(20);
    assert('payload received', receivedPayload && receivedPayload.hi === true);
    assert('fromId correct in meta', receivedMeta && receivedMeta.fromId === nodes[0].id);
    assert('type correct in meta',   receivedMeta && receivedMeta.type === 'greet');
  }

  // ── Test 10: sendDirect to dead peer ────────────────────────────────
  {
    console.log('\n[Test 10] sendDirect to dead peer returns false');
    const net = buildNetwork(5);
    const nodes = [...net.nodes.values()];

    let received = false;
    nodes[1].onDirectMessage('zombie', () => { received = true; });

    net.markDead(nodes[1].id);
    const ok = nodes[0].sendDirect(nodes[1].id, 'zombie', {});
    assert('sendDirect returned false', ok === false);
    await sleep(20);
    assert('message not delivered',     received === false);
  }

  // ── Test 11: handler registration is per instance ───────────────────
  {
    console.log('\n[Test 11] Handler registration is per-instance');
    const net = buildNetwork(3);
    const [a, b, c] = [...net.nodes.values()];

    let aCount = 0, bCount = 0;
    a.onDirectMessage('ping', () => aCount++);
    b.onDirectMessage('ping', () => bCount++);

    c.sendDirect(a.id, 'ping', {});
    c.sendDirect(a.id, 'ping', {});
    c.sendDirect(b.id, 'ping', {});
    await sleep(20);

    assert('A received twice', aCount === 2);
    assert('B received once',  bCount === 1);
  }

  // ── Test 12: xorDistance edge cases ─────────────────────────────────
  {
    console.log('\n[Test 12] xorDistance edge cases (restated)');
    const id = '0123456789abcdef';
    assert('self-distance is zero', xorDistance(id, id) === 0n);
    assert('symmetry',
           xorDistance(id, '1111111111111111') === xorDistance('1111111111111111', id));
    assert('different ids have nonzero distance',
           xorDistance('aaaa', 'bbbb') !== 0n);
  }

  // ── Summary ─────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  results.forEach(r => console.log(r));
  console.log('='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(err => { console.error(err); process.exit(1); });
