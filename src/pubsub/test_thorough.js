/**
 * Thorough verification of pubsub.js before integration.
 *
 * Covers:
 *   1. Basic subscribe/publish/receive across mock network
 *   2. Immediate vs queued handling
 *   3. processEvents() drain semantics
 *   4. Wildcard matching (*:event, domain:*, *:*)
 *   5. System-topic wildcard exclusion (__ prefix)
 *   6. PubSubNode destroy() cleanup
 *   7. Multiple subscribers on same topic
 *   8. Duplicate subscribe should not send duplicate upstream
 *   9. Unsubscribe while still having other handlers on same topic
 *  10. Race: publish before subscribe propagates (should drop)
 *  11. Sender self-delivery (publisher sees their own event locally but not echoed back)
 *  12. Payload round-trip preserves data
 *  13. Invalid domain with ':' throws
 *  14. receiveMessage with non-publish action is ignored
 *  15. JSON.stringify failure does not crash publish()
 *  16. Vote handling (sugar for immediate + suffix)
 */

import { PubSubDomain, PubSubNode, PubSubManager } from './pubsub.js';

// ── Mock network with configurable latency ────────────────────────────────────
class MockNetwork {
  constructor({ latencyMs = 5 } = {}) {
    this.server = new PubSubManager();
    this.nodes = new Map();
    this.clientIdCounter = 0;
    this.latencyMs = latencyMs;
    this.dropped = 0;

    this.server.sendMessageToClient = (clientId, payload) => {
      const client = this.nodes.get(clientId);
      if (!client) { this.dropped++; return; }
      setTimeout(() => client.receiveMessage(payload), this.latencyMs);
    };
  }

  registerNode(domain) {
    const clientId = 'C' + ++this.clientIdCounter;
    this.nodes.set(clientId, domain);
    domain.sendMessage = (payload) => {
      setTimeout(() => this.server.receiveMessageFromClient(clientId, payload), this.latencyMs);
    };
    return clientId;
  }

  disconnect(clientId) { this.nodes.delete(clientId); }
}

// ── Test harness ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0;
const results = [];
function assert(name, cond, detail = '') {
  if (cond) { passed++; results.push(`  ✓ ${name}`); }
  else { failed++; results.push(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function run() {
  // ── Test 1-2: Basic + immediate vs queued ────────────────────────────────
  {
    console.log('\n[Test 1-3] Basic publish + handling modes');
    const net = new MockNetwork();
    const dA = new PubSubDomain(); net.registerNode(dA);
    const dB = new PubSubDomain(); net.registerNode(dB);
    const nB = new PubSubNode(dB);
    let immediateFires = 0, queuedFires = 0;

    nB.subscribe('t', 'immediate', () => immediateFires++, 'immediate');
    nB.subscribe('t', 'queued',    () => queuedFires++,    'queued');
    await sleep(30);

    const nA = new PubSubNode(dA);
    nA.publish('t', 'immediate', 1);
    nA.publish('t', 'queued',    1);
    await sleep(30);

    assert('immediate handler fires on receive', immediateFires === 1);
    assert('queued handler does NOT fire until processEvents()', queuedFires === 0);

    const n = dB.processEvents();
    assert('processEvents drains queued handlers', queuedFires === 1 && n === 1);
  }

  // ── Test 4: Wildcards ────────────────────────────────────────────────────
  {
    console.log('\n[Test 4] Wildcard matching');
    const net = new MockNetwork();
    const dA = new PubSubDomain(); net.registerNode(dA);
    const dB = new PubSubDomain(); net.registerNode(dB);
    const nA = new PubSubNode(dA), nB = new PubSubNode(dB);

    let cDomainWild = 0, cEventWild = 0, cGlobalWild = 0, cExact = 0;
    nB.subscribe('chat', '*',      () => cDomainWild++, 'immediate');
    nB.subscribe('*',    'typing', () => cEventWild++,  'immediate');
    nB.subscribe('*',    '*',      () => cGlobalWild++, 'immediate');
    nB.subscribe('chat', 'typing', () => cExact++,      'immediate');
    await sleep(30);

    nA.publish('chat', 'typing', {});
    await sleep(30);
    assert('exact match fires', cExact === 1);
    assert('domain:* matches chat:typing', cDomainWild === 1);
    assert('*:event matches chat:typing', cEventWild === 1);
    assert('*:* matches chat:typing', cGlobalWild === 1);

    nA.publish('other', 'typing', {});
    await sleep(30);
    assert('*:event matches other:typing', cEventWild === 2);
    assert('chat:* does NOT match other:typing', cDomainWild === 1);
    assert('*:* matches other:typing', cGlobalWild === 2);
  }

  // ── Test 5: System topic (__) excluded from wildcards ────────────────────
  {
    console.log('\n[Test 5] System topics (__*__) bypass wildcards');
    const net = new MockNetwork();
    const dA = new PubSubDomain(); net.registerNode(dA);
    const dB = new PubSubDomain(); net.registerNode(dB);
    const nA = new PubSubNode(dA), nB = new PubSubNode(dB);

    let wildcardCount = 0, exactCount = 0;
    nB.subscribe('*',      '*',       () => wildcardCount++, 'immediate');
    nB.subscribe('__sys__','__evt__', () => exactCount++,    'immediate');
    await sleep(30);

    nA.publish('__sys__', '__evt__', {});
    await sleep(30);
    assert('system topic delivers to exact subscriber', exactCount === 1);
    assert('system topic does NOT leak to *:*',       wildcardCount === 0);
  }

  // ── Test 6: destroy() removes all subscriptions ──────────────────────────
  {
    console.log('\n[Test 6] Node destroy() cleanup');
    const net = new MockNetwork();
    const dA = new PubSubDomain(); net.registerNode(dA);
    const dB = new PubSubDomain(); net.registerNode(dB);
    const nA = new PubSubNode(dA), nB = new PubSubNode(dB);

    let fires = 0;
    nB.subscribe('x', 'y', () => fires++, 'immediate');
    nB.subscribe('x', 'z', () => fires++, 'immediate');
    await sleep(30);

    nB.destroy();
    await sleep(30);

    nA.publish('x', 'y', {});
    nA.publish('x', 'z', {});
    await sleep(30);

    assert('destroy removes all handlers', fires === 0);
    assert('subscribers map empty after destroy', dB.subscribers.size === 0);
    assert('subscriptions map empty after destroy',
           Object.keys(dB.subscriptions).length === 0);
  }

  // ── Test 7-8: Multiple local subscribers; dedup upstream ─────────────────
  {
    console.log('\n[Test 7-8] Multiple local subscribers + upstream dedup');
    const net = new MockNetwork();
    const dA = new PubSubDomain(); net.registerNode(dA);
    const dB = new PubSubDomain(); net.registerNode(dB);
    const n1 = new PubSubNode(dB), n2 = new PubSubNode(dB), nA = new PubSubNode(dA);

    let c1 = 0, c2 = 0, upstreamSubs = 0;
    const origSend = dB.sendMessage;
    dB.sendMessage = (msg) => {
      const p = JSON.parse(msg);
      if (p.action === 'subscribe') upstreamSubs++;
      origSend(msg);
    };

    n1.subscribe('t', 'e', () => c1++, 'immediate');
    n2.subscribe('t', 'e', () => c2++, 'immediate');
    await sleep(30);

    assert('second local subscriber does not send second upstream subscribe',
           upstreamSubs === 1, `got ${upstreamSubs}`);

    nA.publish('t', 'e', {});
    await sleep(30);
    assert('both local subscribers fire', c1 === 1 && c2 === 1);

    // Test 9: unsubscribe one, other should still fire
    n1.unsubscribe('t', 'e');
    await sleep(30);
    nA.publish('t', 'e', {});
    await sleep(30);
    assert('remaining subscriber still fires after partial unsubscribe',
           c1 === 1 && c2 === 2);
  }

  // ── Test 10: Order-preserving transport delivers correctly ───────────────
  //   Note: JavaScript's event loop with uniform-latency setTimeout preserves
  //   order, so subscribe lands at the server before publish. Real-world
  //   reordering (e.g., our Axonal tree where subscribe goes up-tree and
  //   publish fans out via a different path) could still race — that's a
  //   transport-layer concern, handled by the adapter's gap detection.
  {
    console.log('\n[Test 10] Causal order: subscribe-then-publish delivers');
    const net = new MockNetwork({ latencyMs: 20 });
    const dA = new PubSubDomain(); net.registerNode(dA);
    const dB = new PubSubDomain(); net.registerNode(dB);
    const nA = new PubSubNode(dA), nB = new PubSubNode(dB);

    let fires = 0;
    nB.subscribe('race', 'early', () => fires++, 'immediate');
    nA.publish('race', 'early', {});  // no pre-delay — order-preserving mock
    await sleep(100);
    assert('causal-order transport delivers subscribe+publish', fires === 1,
           `observed ${fires}`);
  }

  // ── Test 11: Sender gets local delivery but no echo ──────────────────────
  {
    console.log('\n[Test 11] Publisher local delivery + no echo back');
    const net = new MockNetwork();
    const dA = new PubSubDomain(); net.registerNode(dA);
    const nA = new PubSubNode(dA);

    let aFires = 0;
    nA.subscribe('self', 'event', () => aFires++, 'immediate');
    await sleep(30);

    nA.publish('self', 'event', {});
    await sleep(30);
    assert('publisher fires own handler exactly once (local, no network echo)',
           aFires === 1, `got ${aFires}`);
  }

  // ── Test 12: Payload fidelity ────────────────────────────────────────────
  {
    console.log('\n[Test 12] Payload round-trip fidelity');
    const net = new MockNetwork();
    const dA = new PubSubDomain(); net.registerNode(dA);
    const dB = new PubSubDomain(); net.registerNode(dB);
    const nA = new PubSubNode(dA), nB = new PubSubNode(dB);

    let received = null;
    nB.subscribe('d', 'e', (data) => { received = data; }, 'immediate');
    await sleep(30);

    const payload = { nums: [1, 2, 3], nested: { s: 'hi', b: true, n: null }, empty: [] };
    nA.publish('d', 'e', payload);
    await sleep(30);

    assert('round-trip preserves nested object',
           JSON.stringify(received) === JSON.stringify(payload));
  }

  // ── Test 13: Invalid domain throws ───────────────────────────────────────
  {
    console.log('\n[Test 13] Domain containing : is rejected');
    const d = new PubSubDomain();
    let threw = false;
    try { d.addSubscription('bad:domain', 'e', 'S1', () => {}, 'immediate'); }
    catch (err) { threw = true; }
    assert('domain with ":" throws', threw);
  }

  // ── Test 14: Non-publish inbound actions are dropped ─────────────────────
  {
    console.log('\n[Test 14] receiveMessage drops non-publish actions');
    const d = new PubSubDomain();
    let fires = 0;
    d.addSubscription('x', 'y', 'S1', () => fires++, 'immediate');
    d.receiveMessage(JSON.stringify({ action: 'subscribe', domain: 'x', event: 'y' }));
    d.receiveMessage(JSON.stringify({ action: 'unsubscribe', domain: 'x', event: 'y' }));
    assert('subscribe/unsubscribe inbound actions do not fire handlers', fires === 0);

    d.receiveMessage(JSON.stringify({ action: 'publish', domain: 'x', event: 'y', data: {} }));
    assert('publish inbound action does fire handlers', fires === 1);
  }

  // ── Test 15: JSON.stringify failure ──────────────────────────────────────
  {
    console.log('\n[Test 15] Non-serializable data does not crash publish');
    const d = new PubSubDomain();
    d.sendMessage = () => {};
    const circ = {}; circ.self = circ;
    let crashed = false;
    try { d.publish('x', 'y', circ); } catch (e) { crashed = true; }
    assert('circular data does not throw out of publish', !crashed);
  }

  // ── Test 16: Vote handling is sugar for immediate + suffix ───────────────
  {
    console.log('\n[Test 16] vote handling');
    const d = new PubSubDomain();
    d.sendMessage = () => {};
    let fires = 0;
    d.addSubscription('x', 'y', 'S1', () => fires++, 'vote');
    // Vote sub is stored under 'x:y#__vote' with immediate handling
    d._handleLocalEvent('x', 'y#__vote', {});
    assert('vote handler registered under #__vote suffix', fires === 1);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  results.forEach(r => console.log(r));
  console.log('='.repeat(60));
  console.log(`Results: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch(err => { console.error(err); process.exit(1); });
