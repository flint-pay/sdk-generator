import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { publicTypePlanner } from '../dist/public-type-plan.js';
import { certifies } from '../dist/type-certificate.js';

test(
  'prepared certification scales with depth and union width, including recursive nullable/list/map models',
  { timeout: 60000 },
  (t) => {
    // A child timeout can interrupt exponential synchronous traversal; a test
    // runner timeout alone cannot interrupt a blocked event loop.
    const script = String.raw`
    import assert from 'node:assert/strict';
    import {publicTypePlanner} from './dist/public-type-plan.js';
    import {certifies} from './dist/type-certificate.js';
    const planner=publicTypePlanner({
      Nullable:'{value:string;next:Nullable|null}',
      Optional:'{value:string;next?:Optional}',
      List:'{value:string;children:List[]}',
      Map:'{value:string;children:Record<string,Map>}',
    });
    const payload=(kind,depth)=>{
      let value=kind==='Nullable'?null:undefined;
      for(let i=0;i<depth;i++) value={value:'safe',...(kind==='Nullable'?{next:value}:kind==='Optional'?(value?{next:value}:{}):kind==='List'?{children:value?[value]:[]}:{children:value?{one:value}:{}})};
      return value;
    };
    const baseline=value=>{
      if(value===null || value===undefined) return true;
      if(Array.isArray(value)) return value.every(baseline);
      if(typeof value==='object') return Object.values(value).every(baseline);
      return typeof value==='string';
    };
    const measure=fn=>{
      const batches=[];
      for(let batch=0;batch<7;batch++){
        const start=performance.now();
        for(let i=0;i<256;i++) if(!fn()) throw new Error('valid control rejected');
        batches.push(performance.now()-start);
      }
      return batches.sort((a,b)=>a-b)[3];
    };
    const results=[];
    for(const name of ['Nullable','Optional','List','Map']){
      const certificate=planner(name);
      certifies(payload(name,2),certificate); // Compile once before timing.
      const rows=[16,32,64].map(depth=>{
        const value=payload(name,depth);
        const control=measure(()=>baseline(value));
        const elapsed=measure(()=>certifies(value,certificate));
        // The independent walk calibrates the same worker under the same load.
        assert.ok(elapsed < control*250+100, name+' traversal exceeded the linear control envelope');
        return {name,depth,control,elapsed};
      });
      for(let i=1;i<rows.length;i++){
        const previous=rows[i-1], current=rows[i];
        const linear=Math.max(1,current.control/Math.max(previous.control,0.05));
        assert.ok(current.elapsed <= Math.max(previous.elapsed,0.25)*linear*4+2,
          name+' depth doubling is superlinear: '+JSON.stringify(rows));
      }
      results.push(...rows);
    }
    const wide=width=>publicTypePlanner({})(
      Array.from({length:width},(_,i)=>'{kind:"case'+i+'"; value:{text:string}; required'+i+':true}').join('|')
    );
    const widths=[32,64,128].map(width=>{
      const certificate=wide(width);
      const value={kind:'case'+(width-1),value:{text:'safe'},['required'+(width-1)]:true};
      assert.equal(certifies(value,certificate),true);
      assert.equal(certifies({...value,value:{text:42}},certificate),false);
      const control=measure(()=>baseline({text:'safe'}));
      const elapsed=measure(()=>certifies(value,certificate));
      assert.ok(elapsed < control*1000+250,'wide union exceeded the calibrated bound');
      return {width,control,elapsed};
    });
    for(let i=1;i<widths.length;i++)
      assert.ok(widths[i].elapsed <= Math.max(widths[i-1].elapsed,0.25)*8+5,'wide union scaling');
    // Exercise the actual descriptor/runtime path as well as the standalone plan.
    const {mkdtempSync,writeFileSync,rmSync}=await import('node:fs');
    const {tmpdir}=await import('node:os');
    const {join}=await import('node:path');
    const {pathToFileURL}=await import('node:url');
    const {loadContract,generate}=await import('./dist/index.js');
    const {compileSdkContract}=await import('./dist/target-plan.js');
    const dir=mkdtempSync(join(tmpdir(),'certificate-depth-'));
    const http=[];
    try {
      const schema={type:'object',properties:{value:{type:'string'},next:{anyOf:[{$ref:'#/components/schemas/NullableNode'},{type:'null'}]}},required:['value','next']};
      writeFileSync(join(dir,'api.json'),JSON.stringify({openapi:'3.1.0',info:{title:'Recursive',version:'1'},components:{schemas:{NullableNode:schema}},paths:{'/node':{get:{operationId:'getNode',responses:{200:{description:'OK',content:{'application/json':{schema:{$ref:'#/components/schemas/NullableNode'}}}}}}}}}));
      writeFileSync(join(dir,'sdk.json'),JSON.stringify({version:'1.0.0',targets:['node'],npm:{name:'@example/recursive'},operations:{getNode:{resource:'nodes',method:'get'}}}));
      const contract=loadContract(join(dir,'api.json'),join(dir,'sdk.json'));
      generate(contract,join(dir,'out'));
      const unverified=structuredClone(compileSdkContract(contract).plan.runtime);
      for(const operation of unverified.operations) {delete operation.outputCertificate;delete operation.payloadCertificate;delete operation.itemCertificate;}
      const {Client}=await import(pathToFileURL(join(dir,'out/node/index.js')));
      let body;
      const options={baseUrl:'https://example.invalid',transport:async()=>new Response(body)};
      const client=new Client(options);
      const {runtimeFromPlan}=await import(pathToFileURL(join(dir,'out/node/runtime.js')));
      const reference=runtimeFromPlan(unverified,options);
      const timed=async fn=>{
        const times=[];
        for(let batch=0;batch<5;batch++){
          const start=performance.now();
          for(let i=0;i<4;i++) await fn();
          times.push(performance.now()-start);
        }
        return times.sort((a,b)=>a-b)[2];
      };
      for(const depth of [16,32,64]){
        body=JSON.stringify(payload('Nullable',depth));
        // Identical codec/transport work without certification calibrates its overhead.
        const control=await timed(()=>reference.request('getNode'));
        const elapsed=await timed(()=>client.nodes.get());
        assert.ok(elapsed<control*4+50,'generated recursive client exceeds calibrated bound: '+JSON.stringify({depth,control,elapsed}));
        http.push({depth,control,elapsed});
      }
      for(let i=1;i<http.length;i++)
        assert.ok(http[i].elapsed<Math.max(http[i-1].elapsed,1)*Math.max(1,http[i].control/http[i-1].control)*5+10,'generated client depth scaling');
    } finally {rmSync(dir,{recursive:true,force:true});}
    console.log(JSON.stringify({depths:results,widths,http}));
  `;
    const result = spawnSync(process.execPath, ['--input-type=module', '-'], {
      input: script,
      encoding: 'utf8',
      timeout: 55000,
      maxBuffer: 1024 * 1024,
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    t.diagnostic(result.stdout.trim());
  },
);

test('prepared plans are reusable while value/type memoization stays local to each call', () => {
  const plan = publicTypePlanner({ Node: '{value:string;next:Node|null}' })('Node');
  const shared = { value: 'safe', next: null };
  assert.equal(certifies(shared, plan), true);
  shared.value = 42;
  assert.equal(certifies(shared, plan), false);
  shared.value = 'safe';
  assert.equal(certifies(shared, plan), true);
  shared.next = shared;
  assert.equal(certifies(shared, plan), false);
});
