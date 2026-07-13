// =====================================================================
// diag-root-access.mjs — how does the axon tree actually reach the root?
//
// For one topic on a built+spread mesh, separate THREE things:
//   (a) HINT quality — what findKClosest(topic) returns (local-only adapter
//       that pub/sub uses, AND the iterative network probe), vs the true
//       global XOR-closest. Do peers even agree?
//   (b) ROUTED root access — after subscribing a cohort + publishing, what
//       root(s) does the tree actually form on (axonRoles), are they the
//       true K-closest, and do all subscribers' _upstream pins agree?
//   (c) delivery% — does it work regardless.
//
// Hypothesis: hint can be poor/divergent, yet routed subscribe-k converges
// on a consistent true-ish root → tree forms + delivers. This isolates
// "root access" (routing) from "hint accuracy" (findKClosest).
//
// Env: N SUBS K HASH_BITS WARMUP_LOOKUPS SAMPLE SETTLE DELIVER
// =====================================================================
import {
  shrinkKeyspace, buildMesh, trainLookups, publish, deliveredCount,
  createAuthorIdentity, deriveTopicId, classifyTree, treeStats, roleOf, wait, KERNEL_VERSION,
} from './lib/axon-mesh.mjs';

const N=+(process.env.N||10000), SUBS=+(process.env.SUBS||1000), K=+(process.env.K||20);
const HASH_BITS=+(process.env.HASH_BITS||64), WARM=+(process.env.WARMUP_LOOKUPS||0);
const SAMPLE=+(process.env.SAMPLE||400), SETTLE=+(process.env.SETTLE||3000), DELIVER=+(process.env.DELIVER||3000);
const ks = shrinkKeyspace(HASH_BITS);
const TOPIC={region:'useast',owner:null,name:'root-access',write:'open'};
const topicBig=BigInt('0x'+await deriveTopicId(TOPIC));
const asBig=(x)=>x==null?null:(typeof x==='bigint'?x:BigInt('0x'+x));
const rnd=(n)=>Math.floor(Math.random()*n);

console.log(`diag-root-access kernel v${KERNEL_VERSION} idBits=${ks.idBits} N=${N} SUBS=${SUBS} warmup=${WARM} (spread)`);
const state=await buildMesh({N,K,refresh:100000,renew:1,spread:true});
if(WARM>0){ console.log(`training ${WARM} lookups…`); await trainLookups(state,WARM); }
const peers=[...state.byBig.values()];

// ground truth: true root + true K-closest set
const sorted=peers.map(p=>p.big).sort((a,b)=>{const da=a^topicBig,db=b^topicBig;return da<db?-1:da>db?1:0;});
const trueRoot=sorted[0]; const trueKset=new Set(sorted.slice(0,K));

// (a) HINT quality
let localExact=0, iterExact=0; const localRoots=new Map(), iterRoots=new Map();
const bump=(m,k)=>m.set(String(k),(m.get(String(k))||0)+1);
const sample=peers.slice().sort(()=>Math.random()-0.5).slice(0,SAMPLE);
for(const p of sample){
  const lb=asBig((await p.peer._axonaManager.dht.findKClosest(topicBig,1))?.[0]);
  const ib=asBig((await p.peer.findKClosest(topicBig,1))?.[0]);
  if(lb===trueRoot)localExact++; if(ib===trueRoot)iterExact++;
  if(lb!=null)bump(localRoots,lb); if(ib!=null)bump(iterRoots,ib);
}
const modal=(m)=>{let bk=null,bv=0;for(const[k,v]of m){if(v>bv){bv=v;bk=k;}}return{root:bk,pct:+(100*bv/SAMPLE).toFixed(1),distinct:m.size};};
const lm=modal(localRoots), im=modal(iterRoots);

// (b) ROUTED root access: subscribe cohort + publish
const publisher=peers[0]; publisher.author=await createAuthorIdentity(); publisher.isPublisher=true;
const cohort=peers.slice(1,1+SUBS);
for(const s of cohort){ try{ await s.peer.sub(TOPIC,(env)=>{ if(env?.msgId)s.received.set(String(env.msgId),Date.now()); }); }catch{} }
await wait(SETTLE);
const id=await publish(publisher,TOPIC,'probe'); await wait(DELIVER);
const delivered=deliveredCount(cohort,id);

const ts=treeStats(state,topicBig,trueKset);
// subscriber _upstream agreement: which root each sub pinned
const upRoots=new Map(); let upInTrue=0, upPinned=0;
for(const s of cohort){ const up=s.peer._axonaManager?._upstream?.get(topicBig); if(up&&up.length){ upPinned++; const r=asBig(up[0]); bump(upRoots,r); if(trueKset.has(r))upInTrue++; } }
const um=modal(upRoots);

console.log(`\ntrue root region byte=0x${(trueRoot>>BigInt(ks.idBits-8)).toString(16)}  (K-closest set size ${trueKset.size})`);
console.log(`\n(a) HINT — findKClosest(topic) over ${SAMPLE} random peers:`);
console.log(`   local-only (pub/sub adapter): exact=${(100*localExact/SAMPLE).toFixed(1)}%  modal-root agreement=${lm.pct}%  distinct-answers=${lm.distinct}`);
console.log(`   iterative (network probe):    exact=${(100*iterExact/SAMPLE).toFixed(1)}%  modal-root agreement=${im.pct}%  distinct-answers=${im.distinct}`);
console.log(`\n(b) ROUTED root access — actual tree after subscribe+publish:`);
console.log(`   tree roots=${ts.roots}  in-true-Kset=${ts.rootsInTrue}  spurious=${ts.spuriousRoots}  sub-axons=${ts.subaxons}  depth=${ts.depth}`);
console.log(`   subscriber _upstream: pinned=${upPinned}/${SUBS}  distinct-roots=${um.distinct}  modal-agreement=${um.pct}%  in-true-Kset=${(100*upInTrue/Math.max(1,upPinned)).toFixed(1)}%`);
console.log(`\n(c) delivery: ${delivered}/${SUBS} (${(100*delivered/SUBS).toFixed(1)}%)`);
console.log(`\n→ if hint is divergent but tree roots/_upstream converge: the root is accessed by ROUTING, not the hint.`);
process.exit(0);
