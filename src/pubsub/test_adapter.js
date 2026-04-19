/**
 * test_adapter.js — exercises PubSubAdapter against MockDHTTransport.
 *
 * Covered:
 *   1.  Basic subscribe + publish → subscriber receives payload, metadata intact
 *   2.  Publisher sees own publish locally (via _fireLocal) but transport never
 *       echoes back (MockNetwork excludes sender)
 *   3.  In-order delivery across multiple publishes
 *   4.  Reorder: out-of-order arrival is reassembled within the window
 *   5.  Gap: lost message triggers __gap__ event after window expires
 *   6.  Late packet after gap declared → deferred seq is still delivered in-order
 *   7.  Subscribe then unsubscribe — no further delivery
 *   8.  Multiple publishers on same topic — per-sender seq tracking is independent
 *   9.  Topic hashing — different (domain, event) pairs map to different ids;
 *       same pair always maps to the same id
 *  10.  onGap per-subscribe hook fires with { senderId, fromSeq, toSeq }
 *  11.  Queued handler waits for processEvents() (metadata path preserved)
 *  12.  Destroy cleans up timers and subscriptions
 */

import { PubSubAdapter, topicIdFor } from './PubSubAdapter.js';
import { MockNetwork, MockDHTTransport } from './MockDHTTransport.js';

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let passed = 0, failed = 0;
const results = [];
function assert(name, cond, detail = '') {
  if (cond) { passed++; results.push(`  ✓ ${name}`); }
  else      { failed++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

function makeAdapter(network, nodeId, opts = {}) {
  const transport = new MockDHTTransport(nodeId, network);
  return new PubSubAdapter({ transport, ...opts });
}

async function run() {
  // ── Test 1: Basic delivery ──────────────────────────────────────────────
  {
    console.log('\n[Test 1] Basic subscribe → publish → delivery with metadata');
    const net = new MockNetwork({ defaultLatencyMs: 5 });
    const A = makeAdapter(net, 'NA');
    const B = makeAdapter(net, 'NB');

    let got = null;
    B.subscribe('chat', 'hello', (data, meta) => { got = { data, meta }; }, 'immediate');
    await sleep(20);

    A.publish('chat', 'hello', { text: 'hi' });
    await sleep(40);

    assert('subscriber receives data', got && got.data && got.data.text === 'hi');
    assert('metadata carries senderId', got && got.meta.senderId === 'NA');
    assert('metadata carries seq=1',     got && got.meta.seq === 1);
    assert('metadata carries domain/event', got && got.meta.domain === 'chat' && got.meta.event === 'hello');
  }

  // ── Test 2: Publisher self-delivery ─────────────────────────────────────
  {
    console.log('\n[Test 2] Publisher sees own publish locally, transport does NOT echo');
    const net = new MockNetwork();
    const A = makeAdapter(net, 'NA');

    let selfFires = 0;
    A.subscribe('self', 'event', () => selfFires++, 'immediate');
    await sleep(20);

    A.publish('self', 'event', {});
    await sleep(40);

    assert('publisher fires own handler exactly once', selfFires === 1, `got ${selfFires}`);
  }

  // ── Test 3: In-order delivery across multiple publishes ────────────────
  {
    console.log('\n[Test 3] Multiple in-order publishes');
    const net = new MockNetwork({ defaultLatencyMs: 3 });
    const A = makeAdapter(net, 'NA');
    const B = makeAdapter(net, 'NB');

    const seqs = [];
    B.subscribe('t', 'e', (data, meta) => seqs.push(meta.seq), 'immediate');
    await sleep(20);

    for (let i = 0; i < 5; i++) A.publish('t', 'e', { i });
    await sleep(60);

    assert('received 5 events', seqs.length === 5, `got ${seqs.length}`);
    assert('seqs are 1..5 in order', JSON.stringify(seqs) === '[1,2,3,4,5]',
           `got ${JSON.stringify(seqs)}`);
  }

  // ── Test 4: Reorder closed within window ────────────────────────────────
  {
    console.log('\n[Test 4] Out-of-order arrival reassembled in order (within window)');
    const net = new MockNetwork();
    // Per-message latency: seq 2 arrives fast, seq 1 arrives slower but within window.
    let callCount = 0;
    net.latencyFn = () => [10, 2, 10, 10, 10][callCount++] ?? 5;
    const A = makeAdapter(net, 'NA');
    const B = makeAdapter(net, 'NB', { reorderWindowMs: 200 });

    const delivered = [];
    B.subscribe('t', 'e', (data, meta) => delivered.push(meta.seq), 'immediate');
    await sleep(20);

    A.publish('t', 'e', { n: 1 });  // seq 1, latency 10
    A.publish('t', 'e', { n: 2 });  // seq 2, latency 2 (arrives first)
    await sleep(100);

    assert('two events delivered', delivered.length === 2, `got ${delivered.length}`);
    assert('delivered in sequence order', JSON.stringify(delivered) === '[1,2]',
           `got ${JSON.stringify(delivered)}`);
  }

  // ── Test 5: Gap detection fires __gap__ after window ───────────────────
  {
    console.log('\n[Test 5] Lost message triggers __gap__ event');
    const net = new MockNetwork();
    let idx = 0;
    // Seq 1 is dropped, seq 2 arrives.
    net.dropFn = (_from, _to, _topic) => (idx++ === 0);
    const A = makeAdapter(net, 'NA');
    const B = makeAdapter(net, 'NB', { reorderWindowMs: 80 });

    let gaps = [];
    let receives = [];
    B.subscribe('t', 'e', (data, meta) => receives.push(meta.seq), {
      handling: 'immediate',
      onGap: (info) => gaps.push(info),
    });
    await sleep(20);

    A.publish('t', 'e', { n: 1 });   // dropped
    A.publish('t', 'e', { n: 2 });   // delivered, held in reorder buffer
    await sleep(200);                // wait for window to expire

    assert('exactly one gap reported', gaps.length === 1, `got ${gaps.length}`);
    assert('gap covers seq 1..1',
           gaps[0] && gaps[0].fromSeq === 1 && gaps[0].toSeq === 1,
           gaps[0] ? JSON.stringify(gaps[0]) : 'no gap');
    assert('gap names the sender',    gaps[0] && gaps[0].senderId === 'NA');
    assert('seq 2 delivered after gap declared',
           receives.length === 1 && receives[0] === 2,
           JSON.stringify(receives));
  }

  // ── Test 6: Late packet after gap declared — stale, dropped ─────────────
  //   After we emit __gap__ for seq N, if seq N later arrives it is older
  //   than lastSeen and MUST be dropped silently. Otherwise the app would
  //   see out-of-order events after the gap signal promised a loss.
  {
    console.log('\n[Test 6] Late packet arriving after gap declared is dropped');
    const net = new MockNetwork();
    let first = true;
    // Deliver seq 1 very slowly; seq 2 on time.
    net.latencyFn = () => {
      if (first) { first = false; return 500; }  // seq 1: 500 ms
      return 5;                                   // seq 2+: fast
    };
    const A = makeAdapter(net, 'NA');
    const B = makeAdapter(net, 'NB', { reorderWindowMs: 80 });

    const delivered = [];
    const gaps = [];
    B.subscribe('t', 'e', (data, meta) => delivered.push(meta.seq), {
      handling: 'immediate',
      onGap: (info) => gaps.push(info),
    });
    await sleep(20);

    A.publish('t', 'e', { n: 1 });   // very slow
    A.publish('t', 'e', { n: 2 });   // fast
    await sleep(200);                // window expires; seq 1 not yet here
    await sleep(400);                // seq 1 finally arrives

    assert('gap declared for seq 1', gaps.length === 1 && gaps[0].fromSeq === 1 && gaps[0].toSeq === 1);
    assert('seq 2 delivered',        delivered.includes(2));
    assert('stale seq 1 dropped (never delivered)',
           !delivered.includes(1), `delivered=${JSON.stringify(delivered)}`);
  }

  // ── Test 7: Unsubscribe stops delivery ──────────────────────────────────
  {
    console.log('\n[Test 7] Unsubscribe halts further delivery');
    const net = new MockNetwork();
    const A = makeAdapter(net, 'NA');
    const B = makeAdapter(net, 'NB');

    let fires = 0;
    const cb = () => fires++;
    B.subscribe('t', 'e', cb, 'immediate');
    await sleep(20);

    A.publish('t', 'e', {});
    await sleep(30);
    assert('fires once before unsubscribe', fires === 1);

    B.unsubscribe('t', 'e', cb);
    await sleep(20);

    A.publish('t', 'e', {});
    await sleep(30);
    assert('no further fires after unsubscribe', fires === 1, `got ${fires}`);
  }

  // ── Test 8: Two publishers, independent seq tracking per sender ────────
  {
    console.log('\n[Test 8] Per-sender seq tracking is independent');
    const net = new MockNetwork();
    const A = makeAdapter(net, 'NA');
    const B = makeAdapter(net, 'NB');
    const C = makeAdapter(net, 'NC');

    const log = [];
    C.subscribe('t', 'e', (data, meta) => log.push(`${meta.senderId}#${meta.seq}`), 'immediate');
    await sleep(20);

    A.publish('t', 'e', {}); A.publish('t', 'e', {});
    B.publish('t', 'e', {}); B.publish('t', 'e', {}); B.publish('t', 'e', {});
    await sleep(60);

    // Both publishers start their sequence at 1. C must not confuse them.
    const fromA = log.filter(s => s.startsWith('NA'));
    const fromB = log.filter(s => s.startsWith('NB'));
    assert('A delivered 2 in sequence', JSON.stringify(fromA) === '["NA#1","NA#2"]');
    assert('B delivered 3 in sequence', JSON.stringify(fromB) === '["NB#1","NB#2","NB#3"]');
  }

  // ── Test 9: Topic hashing is deterministic and well-distributed ────────
  {
    console.log('\n[Test 9] Topic hashing');
    assert('same (domain,event) → same topicId',
           topicIdFor('chat', 'hello') === topicIdFor('chat', 'hello'));
    assert('different domain → different topicId',
           topicIdFor('chat', 'hello') !== topicIdFor('game', 'hello'));
    assert('different event → different topicId',
           topicIdFor('chat', 'hello') !== topicIdFor('chat', 'goodbye'));
    assert('topicId is 16-hex-char 64-bit',
           /^[0-9a-f]{16}$/.test(topicIdFor('chat', 'hello')),
           topicIdFor('chat', 'hello'));

    // Collision sanity: a thousand variants should have no collisions.
    const seen = new Set();
    let collisions = 0;
    for (let i = 0; i < 1000; i++) {
      const id = topicIdFor('d', 'e' + i);
      if (seen.has(id)) collisions++;
      seen.add(id);
    }
    assert('no collisions across 1000 distinct events', collisions === 0, `got ${collisions}`);
  }

  // ── Test 10: onGap per-topic hook fires separately from global ─────────
  {
    console.log('\n[Test 10] onGap hook isolated per topic');
    const net = new MockNetwork();
    let callIdx = 0;
    // drop first message on topic t1, not on t2
    net.dropFn = (_from, _to, topicId) => {
      if (topicId === topicIdFor('t1', 'e')) return callIdx++ === 0;
      return false;
    };
    const A = makeAdapter(net, 'NA');
    const B = makeAdapter(net, 'NB', { reorderWindowMs: 60 });

    const t1Gaps = [], t2Gaps = [];
    B.subscribe('t1', 'e', () => {}, { handling: 'immediate', onGap: (i) => t1Gaps.push(i) });
    B.subscribe('t2', 'e', () => {}, { handling: 'immediate', onGap: (i) => t2Gaps.push(i) });
    await sleep(20);

    A.publish('t1', 'e', {});  // dropped
    A.publish('t1', 'e', {});  // delivered, held
    A.publish('t2', 'e', {});  // delivered
    await sleep(200);

    assert('t1 gets exactly one gap', t1Gaps.length === 1, `got ${t1Gaps.length}`);
    assert('t2 gets no gap',           t2Gaps.length === 0, `got ${t2Gaps.length}`);
  }

  // ── Test 11: Queued handling waits for processEvents() ─────────────────
  {
    console.log('\n[Test 11] Queued handling defers until processEvents');
    const net = new MockNetwork();
    const A = makeAdapter(net, 'NA');
    const B = makeAdapter(net, 'NB');

    let fires = 0;
    B.subscribe('t', 'e', (data, meta) => fires++, 'queued');
    await sleep(20);

    A.publish('t', 'e', {});
    await sleep(40);

    assert('queued handler not fired without processEvents', fires === 0);
    const n = B.processEvents();
    assert('processEvents drains the queued handler', fires === 1 && n === 1);
  }

  // ── Test 12: destroy cleans up ─────────────────────────────────────────
  {
    console.log('\n[Test 12] destroy() cleans up');
    const net = new MockNetwork();
    const A = makeAdapter(net, 'NA');
    const B = makeAdapter(net, 'NB');

    let fires = 0;
    B.subscribe('t', 'e', () => fires++, 'immediate');
    await sleep(20);

    B.destroy();
    await sleep(20);

    A.publish('t', 'e', {});
    await sleep(30);

    assert('no fires after destroy', fires === 0, `got ${fires}`);
    assert('no lingering trackers',  B.trackers.size === 0);
  }

  // ── Summary ────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  results.forEach(r => console.log(r));
  console.log('='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(err => { console.error(err); process.exit(1); });
