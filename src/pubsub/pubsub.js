/**
 * A generalized Publish/Subscribe library based on the Croquet event domain mechanism.
 * Allows for local subscription routing and network message serialization.
 */

const VOTE_SUFFIX = '#__vote';

export class PubSubDomain {
    constructor() {
        /** maps topic to handlers, handling is either "immediate" or "queued" */
        this.subscriptions = {};
        /** maps subscriber to subscribed topics */
        this.subscribers = new Map();
        /** true if we have any generic subscriptions, with "*" as domain or event */
        this.genericSubscriptions = false;
        /** queue of events to be processed later */
        this.queuedEvents = [];
        /** counter for subscriberIds */
        this.subscriberIds = 0;
        
        /** 
         * Network Hook: Override this to dispatch payloads over the network.
         * Default implementation logs out a warning.
         */
        this.sendMessage = (jsonString) => {
            console.warn("PubSubDomain: sendMessage not overridden. Dropped payload:", jsonString);
        };
    }

    /** 
     * Register a new participant to receive a unique subscriber ID 
     * @returns {String} Subscriber ID
     */
    register() {
        return "S" + ++this.subscriberIds;
    }

    /** Add a subscription
     * @param {String} domain - a string that publishers and subscribers agree on
     * @param {String} event - a name for the event
     * @param {String} subscriberId - the owner of this subscription
     * @param {Function} callback - a function called when event is published in domain
     * @param {"immediate"|"queued"|"vote"} handling - when to invoke the handler
     */
    addSubscription(domain, event, subscriberId, callback, handling = "queued") {
        if (domain.includes(':')) throw Error(`Invalid subscription domain "${domain}" (must not contain ':')`);

        if (handling === 'vote') {
            this.addSubscription(domain, event + VOTE_SUFFIX, subscriberId, callback, 'immediate');
            return;
        }

        if (domain === "*" || event === "*") this.genericSubscriptions = true;

        const topic = domain + ":" + event;
        const handler = callback;
        // attach subscriber owner
        handler.for = subscriberId;
        
        const needsNetworkSubscribe = !this.subscriptions[topic];

        let handlers = this.subscriptions[topic];
        if (!handlers) {
            handlers = this.subscriptions[topic] = {
                immediate: new Set(),
                queued: new Set()
            };
        }
        if (!handlers[handling]) {
             throw Error(`Unknown subscribe() option: handling="${handling}"`);
        }
        handlers[handling].add(handler);
        
        let topics = this.subscribers.get(subscriberId);
        if (!topics) this.subscribers.set(subscriberId, topics = new Set());
        topics.add(topic);

        if (needsNetworkSubscribe) {
            try {
                this.sendMessage(JSON.stringify({ action: 'subscribe', domain, event }));
            } catch (err) {
                console.warn(`PubSubDomain: subscribe() transport failed for ${domain}:${event}`, err);
            }
        }
    }

    /** Remove a subscription */
    removeSubscription(domain, event, subscriberId, callback=null) {
        const topic = domain + ":" + event;
        const handlers = this.subscriptions[topic];
        if (handlers) {
            const remaining = this._removeHandlers(handlers, subscriberId, callback);
            if (remaining === "none") {
                delete this.subscriptions[topic];
                try {
                    this.sendMessage(JSON.stringify({ action: 'unsubscribe', domain, event }));
                } catch (err) {
                    console.warn(`PubSubDomain: unsubscribe() transport failed for ${domain}:${event}`, err);
                }
            }
            if (remaining !== "subscriber") {
                const topics = this.subscribers.get(subscriberId);
                if (topics) {
                    topics.delete(topic);
                    if (topics.size === 0) this.subscribers.delete(subscriberId);
                }
            }
        }
        if (!event.endsWith(VOTE_SUFFIX)) this.removeSubscription(domain, event + VOTE_SUFFIX, subscriberId);
    }

    /** Remove all subscriptions for a specific subscriber id */
    removeAllSubscriptionsFor(subscriberId) {
        const topics = this.subscribers.get(subscriberId);
        if (topics) {
            for (const topic of topics) {
                const handlers = this.subscriptions[topic];
                if (handlers) {
                    const remaining = this._removeHandlers(handlers, subscriberId);
                    if (remaining === "none") {
                        delete this.subscriptions[topic];
                        const [domain, event] = topic.split(':');
                        try {
                            this.sendMessage(JSON.stringify({ action: 'unsubscribe', domain, event }));
                        } catch (err) {
                            console.warn(`PubSubDomain: cleanup unsubscribe() transport failed for ${domain}:${event}`, err);
                        }
                    }
                }
            }
            this.subscribers.delete(subscriberId);
        }
    }

    /** Internal logic to cull matching handlers */
    _removeHandlers(handlers, subscriberId, callback=null) {
        let remaining = "none";
        for (const handling of Object.keys(handlers)) {
            for (const handler of handlers[handling]) {
                if (handler.for !== subscriberId) {
                    if (remaining === "none") remaining = "others";
                    continue;
                }
                const isMatch = callback === null || 
                                handler === callback || 
                                handler.unbound === callback;
                if (isMatch) {
                    handlers[handling].delete(handler);
                } else {
                    remaining = "subscriber";
                }
            }
        }
        return remaining;
    }

    /** Match subscriptions intelligently including wildcard '*' fallbacks */
    _subscriptionsFor(topic) {
        const subscription = this.subscriptions[topic];
        if (!subscription && !this.genericSubscriptions) return null;
        
        const subscriptions = [];
        let hasUserSubcription = !!subscription;
        
        if (this.genericSubscriptions) {
            const [ domain, event ] = topic.split(':');
            if (!((domain.startsWith("__") && domain.endsWith("__"))
                || (event.startsWith("__") && event.endsWith("__")))) {
                for (const generic of ["*:*", domain + ":*", "*:" + event]) {
                    const genericSubscription = this.subscriptions[generic];
                    if (genericSubscription) {
                        subscriptions.push([genericSubscription, generic]);
                        if (!hasUserSubcription) {
                            // Assume generic subscriptions are user subscriptions for simplicity
                            hasUserSubcription = true;
                        }
                    }
                }
            }
            const onlyGeneric = !hasUserSubcription;
            if (onlyGeneric) {
                for (const genericSubscription of subscriptions) {
                    genericSubscription.push(onlyGeneric);
                }
            }
        }
        if (subscription) subscriptions.push([subscription, topic]);
        if (subscriptions.length === 0) return null;
        return subscriptions;
    }

    /**
     * Publish an event locally and serialize it out to the network.
     */
    publish(domain, event, data) {
        // 1. Send it locally
        this._handleLocalEvent(domain, event, data);

        // 2. Serialize and send over network.
        // Handlers that subscribe can't transmit non-serializable elements directly over the network.
        // Serialization is wrapped in try/catch so that non-serializable data
        // (circular refs, BigInts, functions) does not crash the caller —
        // local delivery has already succeeded.
        try {
            const payload = JSON.stringify({ action: 'publish', domain, event, data });
            this.sendMessage(payload);
        } catch (err) {
            console.error(`PubSubDomain: Error publishing ${domain}:${event}`, err);
        }
    }

    /**
     * Hook to process incoming payloads from a network equivalent receiver.
     */
    receiveMessage(jsonString) {
        try {
            const { action, domain, event, data } = JSON.parse(jsonString);
            if (!domain || !event) {
                 console.warn("PubSubDomain: receiveMessage payload missing domain or event.");
                 return;
            }
            // Only handle 'publish' messages or payloads without explicit actions
            if (action && action !== 'publish') return;
            // Trigger local handlers, but do not re-broadcast to the network 
            // since we are just the receiver.
            this._handleLocalEvent(domain, event, data);
        } catch (err) {
            console.error("PubSubDomain: Error parsing received message.", err, jsonString);
        }
    }

    /**
     * Resolves matching topic handlers and either fires immediately or queues them up.
     */
    _handleLocalEvent(domain, event, data) {
        const topic = domain + ":" + event;
        const subscriptions = this._subscriptionsFor(topic);
        if (!subscriptions) return;
        
        let queuedCount = 0;
        
        for (const [handlers, currentEvent, onlyGeneric] of subscriptions) {
             queuedCount += (handlers.queued && handlers.queued.size) || 0;
             if (handlers.immediate && handlers.immediate.size > 0) {
                 for (const handler of handlers.immediate) {
                     try { handler(data); }
                     catch(err) {
                         console.error(`PubSubDomain error in immediate subscription ${currentEvent}:`, err);
                     }
                 }
             }
        }
        
        if (queuedCount > 0) {
            this.queuedEvents.push({ topic, data });
        }
    }

    /** 
     * Process all queued events sequentially. This is often tied to an event loop or requestAnimationFrame.
     * @returns {Number} number of evaluated queue blocks
     */
    processEvents() {
        let n = 0;
        // Make a shallow copy of events incase new events are queued during processing
        const eventsToProcess = [...this.queuedEvents];
        this.queuedEvents.length = 0;
        
        for (const {topic, data} of eventsToProcess) {
            const subscriptions = this._subscriptionsFor(topic);
            if (!subscriptions) continue;
            
            for (const [handlers] of subscriptions) {
                if (!handlers.queued) continue;
                for (const handler of handlers.queued) {
                    try { handler(data); }
                    catch(err) {
                        console.error(`PubSubDomain error in queued subscription ${topic}:`, err);
                    }
                    n++;
                }
            }
        }
        
        return n;
    }
}

/** 
 * Class wrapper/mixin that handles self-managed identifiers & bindings easily
 * used as a base class for Models, Views, and other domain nodes. 
 */
export class PubSubNode {
    /**
     * @param {PubSubDomain} pubSubDomain 
     */
    constructor(pubSubDomain) {
        this.pubSubDomain = pubSubDomain;
        this.subscriberId = pubSubDomain.register();
    }
    
    /**
     * Binds a local handler to an event.
     */
    subscribe(domain, event, callback, handling = "queued") {
        if (typeof callback !== "function") {
            const methodName = callback;
            if (typeof this[methodName] !== "function") {
                throw Error(`PubSubNode: subscribe() error. No method ${methodName} on node class.`);
            }
            callback = this[methodName].bind(this);
            // preserve logical name identity for easy unsubscribing
            callback.unbound = methodName; 
        }
        this.pubSubDomain.addSubscription(domain, event, this.subscriberId, callback, handling);
    }
    
    /**
     * Unsubscribes a bound handler.
     */
    unsubscribe(domain, event, callback=null) {
        this.pubSubDomain.removeSubscription(domain, event, this.subscriberId, callback);
    }
    
    /**
     * Triggers event and payloads it down the `PubSubDomain` tree across the network.
     */
    publish(domain, event, data) {
         this.pubSubDomain.publish(domain, event, data);
    }

    /**
     * Unbinds everything for cleanup.
     */
    destroy() {
        this.pubSubDomain.removeAllSubscriptionsFor(this.subscriberId);
    }
}

/**
 * Server-side PubSub Manager that maintains network subscriber tables
 * and routes published events only to interested clients.
 */
export class PubSubManager {
    constructor() {
        /** maps topic to Set of clientIds */
        this.networkSubscriptions = new Map();
        
        /** 
         * Hook to send messages to specific clients.
         * Must be overridden by the implementer.
         */
        this.sendMessageToClient = (clientId, jsonString) => {
            console.warn(`PubSubManager: sendMessageToClient not overridden. Dropped message for ${clientId}`);
        };
    }

    /**
     * Receives a message from a specific client.
     */
    receiveMessageFromClient(clientId, jsonString) {
        try {
            const payload = JSON.parse(jsonString);
            const { action, domain, event, data } = payload;
            
            if (!domain || !event) return;
            const topic = domain + ":" + event;

            if (action === 'subscribe') {
                if (!this.networkSubscriptions.has(topic)) {
                    this.networkSubscriptions.set(topic, new Set());
                }
                this.networkSubscriptions.get(topic).add(clientId);
            } 
            else if (action === 'unsubscribe') {
                if (this.networkSubscriptions.has(topic)) {
                    this.networkSubscriptions.get(topic).delete(clientId);
                    if (this.networkSubscriptions.get(topic).size === 0) {
                        this.networkSubscriptions.delete(topic);
                    }
                }
            } 
            else if (action === 'publish' || !action) { 
                // Forward the publish payload to all subscribed clients
                const subscribers = this._getSubscribersForTopic(topic);
                const forwardPayload = JSON.stringify({ action: 'publish', domain, event, data });
                
                for (const targetClientId of subscribers) {
                    // Do not echo the published message back to the originating client.
                    // The client's local PubSubDomain has already triggered local handlers.
                    if (targetClientId !== clientId) { 
                        this.sendMessageToClient(targetClientId, forwardPayload);
                    }
                }
            }
        } catch (err) {
            console.error("PubSubManager: Error processing message from client.", err);
        }
    }
    
    /**
     * Match subscriptions including wildcards
     */
    _getSubscribersForTopic(topic) {
        const [domain, event] = topic.split(':');
        const recipients = new Set();
        
        const possibleTopics = [
            topic,
            `${domain}:*`,
            `*:${event}`,
            `*:*`
        ];
        
        for (const pt of possibleTopics) {
            const clients = this.networkSubscriptions.get(pt);
            if (clients) {
                for (const c of clients) recipients.add(c);
            }
        }
        
        return recipients;
    }
}

