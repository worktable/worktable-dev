import {chromium} from 'playwright-core';
import {readFile,writeFile} from 'node:fs/promises';
const b=await chromium.connectOverCDP(process.env.CDP_URL || 'http://127.0.0.1:18800');
const before=JSON.parse(await readFile('/tmp/worktable-review.json','utf8')).apiUrl;
const editor=JSON.parse(await readFile('/tmp/worktable-editor-prototype.json','utf8')).apiUrl;
const rows=[];
async function run(label,origin,target,kind){const ctx=await b.newContext({viewport:{width:1280,height:900}}),p=await ctx.newPage(),errors=[];p.on('pageerror',e=>errors.push(String(e)));const c=await ctx.newCDPSession(p);await c.send('Network.enable');await c.send('Network.emulateNetworkConditions',{offline:false,latency:100,downloadThroughput:1250000,uploadThroughput:500000});await c.send('Emulation.setCPUThrottlingRate',{rate:4});
 await p.bringToFront();await p.addInitScript(()=>{if(window!==window.top)return;localStorage.setItem('theme','dark');window.__preview=null;window.__long=[];const obs=new MutationObserver(()=>{if(!document.querySelector('[data-document-preview]'))return;obs.disconnect();requestAnimationFrame(()=>{window.__preview=performance.now()})});obs.observe(document,{subtree:true,childList:true});new PerformanceObserver(l=>window.__long.push(...l.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});});
 const t=Date.now();await p.goto(origin+(kind==='reader'?'/':'/spaces/loading-audit/documents/')+target,{waitUntil:'commit'});
 if(kind==='reader'||kind==='read-current')await p.locator('[data-document-preview] p').first().waitFor({timeout:60000});
 else if(target==='html-audit'){await p.frameLocator('iframe[data-worktable-widget-frame]').getByRole('heading',{name:'Audit HTML ready'}).waitFor({timeout:90000});await p.getByRole('status',{name:'Opening document'}).waitFor({state:'hidden'});}
 else await p.locator(`.bn-editor .bn-block-outer[data-id="p-${Number(target.split('-')[1])-1}"]`).waitFor({timeout:90000});
 const ready=Date.now()-t;const data=await p.evaluate(()=>({previewMs:window.__preview,longtasks:window.__long,resources:performance.getEntriesByType('resource').map(e=>({path:new URL(e.name).pathname,start:e.startTime,duration:e.duration,bytes:e.encodedBodySize})),navigation:performance.getEntriesByType('navigation')[0].toJSON(),paints:performance.getEntriesByType('paint').map(p=>p.toJSON())}));
 rows.push({label,target,kind,ready,errors,...data});console.log(JSON.stringify({label,target,ready,previewMs:data.previewMs,errors}));await ctx.close();await writeFile('/tmp/worktable-reading-recheck.json',JSON.stringify(rows,null,2));}
try{for(let i=1;i<=3;i++){
const pair=i%2?[['current',before,'read-current'],['reader',process.env.READER_ORIGIN || 'http://127.0.0.1:45551','reader']]:[['reader',process.env.READER_ORIGIN || 'http://127.0.0.1:45551','reader'],['current',before,'read-current']];
for(const [label,origin,kind]of pair)await run(label+'-'+i,origin,'rich-10',kind);
}
for(let i=1;i<=3;i++)for(const [label,origin]of (i%2?[['current',before],['shell',process.env.SHELL_ORIGIN || 'http://127.0.0.1:39899']]:[['shell',process.env.SHELL_ORIGIN || 'http://127.0.0.1:39899'],['current',before]]))await run(label+'-html-'+i,origin,'html-audit','editor');
}finally{await b.close()}
