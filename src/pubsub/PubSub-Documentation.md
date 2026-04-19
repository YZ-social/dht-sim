# Network Pub/Sub Library

## Overview
This standalone Publish/Subscribe library is derived from the Croquet architecture but generalized for broader network applicability. It enables bit-identical replicated computation by providing deterministic, localized routing combined with serialized network traversal.

The architecture splits responsibilities into:
1. **`PubSubDomain`**: The publisher/subscriber engine for the client. Evaluates topics, queues matching subscriptions, and communicates to the network over the overridable `sendMessage` hook.
2. **`PubSubNode`**: A base class for models/views providing streamlined lifecycle subscriptions.
3. **`PubSubManager`**: The server-side broker that routes events, maintains global subscription tables, and avoids echoing payloads back to originators.

---

## 👨‍💻 Developer Guide

### Installation & Instantiation
Each logical peer in your network loop requires a localized `PubSubDomain`.

```javascript
import { PubSubDomain, PubSubNode } from './pubsub.js';

// Setup network domain
const networkDomain = new PubSubDomain();

// Link with your actual network implementation
networkDomain.sendMessage = (payloadString) => {
    myNetworkSocket.send(payloadString);
}

myNetworkSocket.on('message', (msg) => {
    networkDomain.receiveMessage(msg);
});
```

### Subscribing to Events
Classes can inherit from `PubSubNode` to inherit lifecycle bindings:

```javascript
class PlayerModel extends PubSubNode {
    constructor(domain) {
         super(domain);
         
         // Using method name binding automatically resolves "this.onJump"
         this.subscribe("Player1", "jump", "onJump");

         // You can also pass functions. 
         // Third option "immediate" fires the moment it matches locally or is received via network.
         // Omitting it defaults to "queued".
         this.subscribe("*", "game_over", (data) => this.endGame(), "immediate");
    }

    onJump(data) {
        console.log(`Jump performed with force ${data.zAxis}`);
    }
}
```

### Publishing Events
Any instantiated `PubSubNode` can broadcast events locally and globally:

```javascript
const p1 = new PlayerModel(networkDomain);

// The following call will:
// 1. Process handlers immediately or add to local networkDomain.queuedEvents.
// 2. Wrap payload to JSON and invoke `networkDomain.sendMessage()`.
p1.publish("Player1", "jump", { zAxis: 15.0 });
```

### Processing Queues
Because networked components often run within strict loops (like `requestAnimationFrame`), `queued` subscriptions will NOT fire until you explicitly process the event loop:

### The Server (PubSubManager)
In a client-server architecture, the `PubSubManager` receives operations from clients and selectively forwards messages.

```javascript
import { PubSubManager } from './pubsub.js';

const server = new PubSubManager();

// Setup the outbound hook
server.sendMessageToClient = (clientId, jsonString) => {
    myNetworkSockets.get(clientId).send(jsonString);
};

// Feed it incoming data containing `clientId` (e.g. socket identifier)
socketServer.on('connection', (clientSocket) => {
    clientSocket.on('message', (msg) => {
        server.receiveMessageFromClient(clientSocket.id, msg);
    });
});
```

---

## 🛠️ Maintainer Guide

### File Breakdown: `pubsub.js`

#### Topic Matching and "Wildcards"
The topic is unified under a `"domain:event"` string format. This prevents deep object instantiation overhead.

When `PubSubDomain._subscriptionsFor(topic)` is executed, it iteratively climbs back:
1. Exact match (`domain:event`)
2. Event Wildcard (`domain:*`)
3. Domain Wildcard (`*:event`)
4. Global Wildcard (`*:*`)

#### Network vs Local Traversal
A key difference in this decoupled library is how network loops are mitigated.
- `publish()` builds the payload and executes `this.sendMessage(json)` **AND** executes local handlers.
- `receiveMessage()` receives the payload from remote peers and **ONLY** executes local handlers. Re-broadcasting would create infinite event loops.

#### Serialization Expectations
Because `sendMessage` mandates JSON strings:
- Complex or cyclical objects **must not** be published. The payload payload struct is strictly `{ domain, event, data }`. `JSON.stringify` failure triggers a console error.
- All incoming payloads traverse through `JSON.parse` securely under a try-catch.

#### Clean-up
Entities (like discarded views) should call `this.destroy()` on the `PubSubNode`. This leverages the isolated internal `_removeHandlers()` sweep to nullify GC memory leaks.
