# DHT Simulator — Claude Interaction Protocol

## App
- Running at **http://localhost:3000** (node server.js)
- Source in `src/`, entry point `index.html`

## Adaptive Benchmark Loop

Claude drives parameter exploration by:
1. Posting an experiment to the server
2. Waiting for the result (`.ready` flag)
3. Reading and analyzing the CSV
4. Logging learnings
5. Posting the next experiment

### Step 1 — Queue a run

```bash
curl -s -X POST http://localhost:3000/api/experiment \
  -H 'Content-Type: application/json' \
  -d '{
    "label": "Coverage sweep 10-50%",
    "hypothesis": "Higher coverage should increase broadcast hops for N-10W",
    "runs": [
      {"nodeCount":50000,"pubsubCoverage":10,"protocols":["kademlia","geo","ngdht10w"],"tests":["global","r2000","pubsub"]},
      {"nodeCount":50000,"pubsubCoverage":25,"protocols":["kademlia","geo","ngdht10w"],"tests":["global","r2000","pubsub"]},
      {"nodeCount":50000,"pubsubCoverage":50,"protocols":["kademlia","geo","ngdht10w"],"tests":["global","r2000","pubsub"]}
    ]
  }'
```

The browser picks this up within 3 seconds and starts the sweep automatically.

### Step 2 — Wait for results

Poll until `.ready` exists:
```bash
# Check status
curl -s http://localhost:3000/api/status
# → {"ready":true,"pendingExperiment":false}

# Or just check the file directly
ls results/.ready
```

### Step 3 — Read the result

```bash
# Read metadata
cat results/.ready

# Read CSV (latest run)
cat results/benchmark_latest.csv

# Or read archived file from .ready metadata
```

### Step 4 — Clear the flag and log learnings

```bash
# Clear .ready so the next result can be detected
curl -s -X DELETE http://localhost:3000/complete

# Append to research log
curl -s -X POST http://localhost:3000/api/log \
  -H 'Content-Type: application/json' \
  -d '{"entry":"Run: Coverage 10-50%\nKey finding: N-10W bcast hops 1.19→3.28 as coverage grows\nNext: test groupSize 16 vs 32 vs 64"}'
```

### Step 5 — Read prior learnings

```bash
curl -s http://localhost:3000/api/log
# or
cat results/research.log
```

## Configurable Run Parameters

Each run object in the `runs` array supports:

| Field | Default | Description |
|-------|---------|-------------|
| `nodeCount` | current UI value | Number of nodes |
| `pubsubCoverage` | current UI value | % of nodes to reach in pub/sub broadcast |
| `pubsubGroupSize` | current UI value | Pub/Sub group size |
| `warmupSessions` | current UI value | Neuromorphic warmup sessions (auto-scales with nodeCount) |
| `protocols` | current UI selection | Array of protocol keys: `kademlia`, `geo`, `ngdht10w`, etc. |
| `tests` | current UI selection | Array of test keys: `global`, `r2000`, `r500`, `pubsub`, `churn`, etc. |

Omitting a field leaves the current UI value unchanged.

## Protocol Keys
- `kademlia` — Kademlia DHT
- `geo` — Geographic DHT (prefix width set by G-DHT Bits parameter, default 8)
- `ngdht10w` — Neuromorphic DHT v10 (best performer)
- `ngdht`, `ngdht2`…`ngdht13w` — other neuromorphic variants
- `ngdhtnx1w` — NX-1W configurable research protocol
- `ngdhtnx2w` — NX-2W broadcast-tree protocol (NX-1W + Rule 15: proximity-ordered fan-out tree) (pass `nx1wRules` to configure)
- `ngdhtnx3` — NX-3 G-DHT three-layer init
- `ngdhtnx4` — NX-4 iterative fallback routing
- `ngdhtnx5` — NX-5 stratified bootstrap + global warmup + incoming promotion (current SOTA)

## Test Keys
- `global` — random global lookups
- `r500`, `r1000`, `r2000`, `r5000` — regional lookups within radius (km)
- `pubsub` — pub/sub broadcast (uses pubsubCoverage and pubsubGroupSize)
- `src`, `dest`, `srcdest` — source/dest-concentrated lookups
- `continent` — cross-continent (NA→Asia)
- `churn` — node churn test (run last, modifies DHT state)

## Result CSV Format

```
# DHT Benchmark — N nodes · 500 lookups/cell
Protocol,global hops,global ms,2000km hops,2000km ms,pubsub →relay hops,...
Kademlia,...
G-DHT,...
N-10W,...

# Run Parameters
Parameter,Value
Nodes,...
Pub/Sub coverage %,...
```

## Key Metrics to Watch
- **Global hops** — lower is better (N-10W typically 35-40% fewer than Kademlia)
- **Regional hops** — N-10W excels here (synaptic locality)
- **Pub/Sub bcast hops** — scales with coverage; N-10W's strongest advantage
- **ms latency** — reflects hops × node delay; compare across protocols

## Files
- `results/benchmark_latest.csv` — latest benchmark result
- `results/benchmark_<ts>.csv` — timestamped archives
- `results/.ready` — JSON flag written on completion, deleted after reading
- `results/research.log` — append-only exploration log
- `src/main.js` — app entry, benchmark logic, sweep integration
- `src/ui/BenchmarkSweep.js` — sweep state machine
- `server.js` — Express server with all endpoints
