import {chromium} from 'playwright-core';
import {readFile,writeFile} from 'node:fs/promises';
const cfg=JSON.parse(await readFile('/tmp/worktable-review.json','utf8'));
const target=process.argv[2]||'rich-2000',label=process.argv[3]||target,rate=Number(process.argv[4]||4);
const origin=process.env.PROFILE_ORIGIN||cfg.apiUrl;
const b=await chromium.connectOverCDP(process.env.CDP_URL || 'http://127.0.0.1:18800');const ctx=await b.newContext({viewport:{width:1280,height:900}});const p=await ctx.newPage();const errors=[];p.on('pageerror',e=>errors.push(String(e)));const c=await ctx.newCDPSession(p);
await p.addInitScript(()=>{if(window!==window.top)return;localStorage.setItem('theme','dark');window.__long=[];new PerformanceObserver(l=>window.__long.push(...l.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({type:'longtask',buffered:true});});
await c.send('Network.enable');await c.send('Network.emulateNetworkConditions',{offline:false,latency:100,downloadThroughput:1250000,uploadThroughput:500000});await c.send('Emulation.setCPUThrottlingRate',{rate});await c.send('Profiler.enable');await c.send('Profiler.setSamplingInterval',{interval:1000});await c.send('Profiler.start');
const t=Date.now();await p.goto(origin+'/spaces/loading-audit/documents/'+target,{waitUntil:'commit'});
if(target.startsWith('rich-'))await p.locator(`.bn-editor .bn-block-outer[data-id="p-${Number(target.split('-')[1])-1}"]`).waitFor({timeout:120000});
else {await p.frameLocator('iframe[data-worktable-widget-frame]').getByRole('heading',{name:'Audit HTML ready'}).waitFor({timeout:90000});await p.getByRole('status',{name:'Opening document'}).waitFor({state:'hidden'});}
const ready=Date.now()-t;
const {profile}=await c.send('Profiler.stop');
const data=await p.evaluate(()=>({longtasks:window.__long,resources:performance.getEntriesByType('resource').map(e=>({url:e.name,start:e.startTime,duration:e.duration,size:e.encodedBodySize})),navigation:performance.getEntriesByType('navigation')[0].toJSON()}));
await writeFile('/tmp/worktable-profile-'+label+'.json',JSON.stringify({target,rate,ready,errors,profile,...data}));console.log(JSON.stringify({label,ready,errors,longtasks:data.longtasks}));await ctx.close();await b.close();
