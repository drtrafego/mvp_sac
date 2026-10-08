interface ColumnSnapshot { id: string; label: string; color: string }
export interface PipelineColumnsSaveInput {
  columns: ColumnSnapshot[]; expectedColumns: ColumnSnapshot[]
  migrateFromColumn?: string; migrateToColumn?: string
}
export type PipelineColumnsSaveResult = { ok:true } | { ok:false; status:number|null; message:string }

/** Keep the original snapshot in the request; never retry a stale configuration blindly. */
export async function savePipelineColumns(
  input: PipelineColumnsSaveInput, fetcher: typeof fetch = fetch,
): Promise<PipelineColumnsSaveResult> {
  try {
    const response=await fetcher('/api/pipeline/columns', {
      method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input),
    })
    if (response.ok) return { ok:true }
    const payload:unknown=await response.json().catch(()=>null)
    const message=payload && typeof payload==='object' && 'error' in payload && typeof payload.error==='string'
      ? payload.error : 'Não foi possível salvar as colunas.'
    return { ok:false,status:response.status,message }
  } catch {
    return { ok:false,status:null,message:'Falha de conexão ao salvar as colunas. Recarregue para conferir o estado atual.' }
  }
}
