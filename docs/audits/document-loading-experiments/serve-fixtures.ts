import { startWebHarness } from './production-harness';
import { mkdir, writeFile } from 'node:fs/promises';
const h = await startWebHarness('loading-audit', { storageVersion: 2 });
const api = async (path: string, method: string, body: unknown) => {
 const r = await fetch(h.apiUrl + path, {method, headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
 if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
 return r.json();
};
await api('/api/spaces','POST',{name:'Loading Audit'});
await mkdir(h.workspacePath('spaces/loading-audit/docs'),{recursive:true});
for (const n of [10,500,2000]) {
 const blocks = Array.from({length:n},(_,i)=>({id:`p-${i}`,type:'paragraph',props:{textColor:'default',backgroundColor:'default',textAlignment:'left'},content:[{type:'text',text:`Audit rich ${n} paragraph ${i}`,styles:{}}],children:[]}));
 await writeFile(h.workspacePath(`spaces/loading-audit/docs/rich-${n}.json`),JSON.stringify(blocks));
}
await writeFile(h.workspacePath('spaces/loading-audit/docs/plain.md'),'# Audit Markdown\n\nReadable audit content.\n');
await api('/api/spaces/loading-audit/widgets','POST',{id:'html-audit',name:'Audit HTML',html:'<!doctype html><html><head><title>Audit HTML</title></head><body><h1>Audit HTML ready</h1><p>No external resources.</p></body></html>'});
const small = JSON.parse(await (await import('node:fs/promises')).readFile(h.workspacePath('spaces/loading-audit/docs/rich-10.json'), 'utf8'));
await api('/api/spaces/loading-audit/docs/rich-10', 'PUT', {content:small});
for (const n of [500,2000]) {
 const content = JSON.parse(await (await import('node:fs/promises')).readFile(h.workspacePath(`spaces/loading-audit/docs/rich-${n}.json`), 'utf8'));
 await api(`/api/spaces/loading-audit/docs/rich-${n}`, 'PUT', {content});
}
await writeFile(process.env.AUDIT_CONFIG || '/tmp/worktable-review.json',JSON.stringify({apiUrl:h.apiUrl,webUrl:h.webUrl,workspace:h.workspacePath()}));
console.log(JSON.stringify({apiUrl:h.apiUrl,webUrl:h.webUrl,workspace:h.workspacePath()}));
process.on('SIGTERM',async()=>{await h.stop();process.exit(0)});
await new Promise(()=>{});
