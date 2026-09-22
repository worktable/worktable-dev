import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {buildDocumentCatalog} from '../../../packages/server/src/document-catalog';
import {setWorkspaceRootOverride} from '../../../packages/server/src/workspace';
const root=await mkdtemp('/tmp/worktable-catalog-isolated-');setWorkspaceRootOverride(root);const options={workspaceRoot:root,spaceId:'scale'};const results=[];
try{await mkdir(root+'/spaces/scale/docs',{recursive:true});await mkdir(root+'/spaces/scale/widgets',{recursive:true});let previous=0;
for(const count of [10,100,500,2000]){
 for(let i=previous;i<count;i+=20)await Promise.all(Array.from({length:Math.min(20,count-i)},(_,j)=>writeFile(root+`/spaces/scale/docs/note-${i+j}.md`,'# Simple note\n\nUnrelated content.\n')));previous=count;
 const samples=[];for(let i=0;i<4;i++){const t=performance.now();const c=await buildDocumentCatalog(options);samples.push({ms:Math.round(performance.now()-t),entries:c.entries.length})}results.push({count,samples});console.log(JSON.stringify(results.at(-1)));
}await writeFile('/tmp/worktable-pure-catalog.json',JSON.stringify(results,null,2));}finally{setWorkspaceRootOverride(null);await rm(root,{recursive:true,force:true})}
