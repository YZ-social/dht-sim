/**
 * NeuromorphicDHTNX13 (NX-13) – NX-10 with Fully Tunable Parameters
 *
 * Identical to NX-10 in every way except:
 *  - Reads from its own config rules (nx13Rules), allowing independent
 *    parameter tuning while NX-10 keeps its defaults
 *  - Has its own protocol name for benchmark comparison
 *
 * This enables A/B testing: run NX-10 (reference) alongside NX-13
 * (experimental) with different parameter values to measure the impact
 * of each rule and find optimal configurations.
 */

import { NeuromorphicDHTNX10 } from './NeuromorphicDHTNX10.js';

export class NeuromorphicDHTNX13 extends NeuromorphicDHTNX10 {
  static get protocolName() { return 'Neuromorphic-NX13'; }

  getStats() {
    return { ...super.getStats(), protocol: 'Neuromorphic-NX13' };
  }
}
