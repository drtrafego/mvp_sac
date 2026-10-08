import assert from 'node:assert/strict'
import { test } from 'node:test'
import { savePipelineColumns } from '../src/components/pipeline/pipeline-column-save'

const before=[{id:'a',label:'A',color:'#333'},{id:'b',label:'B',color:'#333'}]
const input={columns:[before[1]],expectedColumns:before,migrateFromColumn:'a',migrateToColumn:'b'}

async function main() {
await test('real save helper sends the previous snapshot and awaits server acceptance',async()=>{
  let release!:(response:Response)=>void
  const delayed=new Promise<Response>(resolve=>{release=resolve})
  let settled=false
  const saving=savePipelineColumns(input,async(url,options)=>{
    assert.equal(url,'/api/pipeline/columns')
    assert.equal(options?.method,'POST')
    assert.deepEqual(JSON.parse(String(options?.body)),input)
    return delayed
  })
  void saving.then(()=>{settled=true})
  await Promise.resolve()
  assert.equal(settled,false)
  release(new Response(JSON.stringify({success:true}),{status:200}))
  assert.deepEqual(await saving,{ok:true})
})
await test('stale/admin/validation/server errors remain failures and preserve a useful error',async()=>{
  for(const status of [400,403,409,500]) {
    const result=await savePipelineColumns(input,async()=>new Response(JSON.stringify({error:'Recarregue antes de editar.'}),{status}))
    assert.deepEqual(result,{ok:false,status,message:'Recarregue antes de editar.'})
  }
})
await test('network failure never confirms or silently retries a configuration migration',async()=>{
  let requests=0
  const result=await savePipelineColumns(input,async()=>{requests++;throw new Error('network timeout')})
  assert.equal(result.ok,false)
  if(!result.ok){assert.equal(result.status,null);assert.match(result.message,/Recarregue/)}
  assert.equal(requests,1)
})
}
main().catch(error=>{console.error(error);process.exitCode=1})
