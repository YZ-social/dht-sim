import { PubSubDomain, PubSubNode, PubSubManager } from './pubsub.js';

class MockNetwork {
    constructor() {
        this.server = new PubSubManager();
        this.nodes = new Map(); // clientId -> PubSubDomain
        this.clientIdCounter = 0;
        
        // Define server send behavior
        this.server.sendMessageToClient = (clientId, payload) => {
            const client = this.nodes.get(clientId);
            if (client) {
                // Simulate network latency
                setTimeout(() => client.receiveMessage(payload), 5);
            }
        };
    }
    
    registerNode(pubSubDomain) {
        const clientId = 'C' + ++this.clientIdCounter;
        this.nodes.set(clientId, pubSubDomain);
        
        // Define client send behavior
        pubSubDomain.sendMessage = (payload) => {
            // Simulate network latency
            setTimeout(() => this.server.receiveMessageFromClient(clientId, payload), 5);
        };
    }
}

async function runTest() {
    const network = new MockNetwork();

    // Node A
    const domainA = new PubSubDomain();
    network.registerNode(domainA);
    const nodeA = new PubSubNode(domainA);

    // Node B
    const domainB = new PubSubDomain();
    network.registerNode(domainB);
    const nodeB = new PubSubNode(domainB);
    
    let bReceived = 0;

    nodeB.subscribe('system', 'ping', (data) => {
        console.log(`[Node B] Received ping:`, data);
        bReceived++;
    }, 'immediate'); // trigger immediately on receive instead of waiting for domainB.processEvents()

    // Small delay to allow subscription to register on server
    await new Promise(r => setTimeout(r, 20));

    // A publishes message
    nodeA.publish('system', 'ping', { timestamp: Date.now(), msg: 'hello sync' });
    
    // Wait for network propagation (client A -> server -> client B)
    await new Promise(r => setTimeout(r, 50));
    
    console.log(`Test passed: ${bReceived === 1}`);
}

runTest().catch(console.error);
