// Fault injection against isolated production fixtures rich-10 and html-audit.
// Delays only provider CSS; this tests rendering dependency, not slow font files.
import {chromium} from 'playwright-core';
import {writeFile} from 'node:fs/promises';
const b=await chromium.connectOverCDP(process.env.AUDIT_CDP || 'http://127.0.0.1:18800');
const password=process.env.AUDIT_PASSWORD;
const control=process.env.AUDIT_CONTROL_ORIGIN, candidate=process.env.AUDIT_CANDIDATE_ORIGIN;
if(!control || !candidate) throw Error('Set AUDIT_CONTROL_ORIGIN and AUDIT_CANDIDATE_ORIGIN to isolated fixture servers');
const output=process.env.AUDIT_OUTPUT || '/tmp/worktable-font-delay-evidence.json';
const rows=[];
try {for(const target of ['rich-10','html-audit']) for(let iteration=1;iteration<=2;iteration++) for(const [label,origin] of (iteration%2 ? [['control',control],['candidate',candidate]] : [['candidate',candidate],['control',control]])) {
 const ctx=await b.newContext({viewport:{width:1280,height:900}}), p=await ctx.newPage(),errors=[],fontRequests=[];p.on('pageerror',e=>errors.push(String(e))); const c=await ctx.newCDPSession(p);await c.send('Network.enable');await c.send('Network.emulateNetworkConditions',{offline:false,latency:100,downloadThroughput:1250000,uploadThroughput:500000});await c.send('Emulation.setCPUThrottlingRate',{rate:4});
 if(password){const login=await ctx.request.post(origin+'/auth/login',{data:{password},headers:{Origin:origin}});if(!login.ok())throw Error('Fixture login failed: '+login.status());}
 await ctx.route(/https:\/\/(api\.fontshare\.com|fonts\.googleapis\.com)\//,async route=>{fontRequests.push(route.request().url());await new Promise(r=>setTimeout(r,8000));try{await route.fulfill({status:200,contentType:'text/css',body:'/* Controlled 8-second font stylesheet delay. */'});}catch{}});
 await p.addInitScript(()=>{if(window===window.top)localStorage.setItem('theme','dark')});await p.bringToFront();const start=Date.now();
 try {await p.goto(origin+'/spaces/loading-audit/documents/'+target,{waitUntil:'commit'}); if(target==='rich-10') await p.waitForFunction(()=>document.querySelector('.bn-editor[contenteditable="true"]')&&!document.querySelector('[data-document-preview]'),undefined,{timeout:60000});else {await p.frameLocator('iframe[data-worktable-widget-frame]').getByRole('heading',{name:'Audit HTML ready'}).waitFor({timeout:60000});await p.getByRole('status',{name:'Opening document',exact:true}).waitFor({state:'hidden'});}
 await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));const readyMs=Date.now()-start;
 const data=await p.evaluate(()=>({paints:performance.getEntriesByType('paint').map(e=>e.toJSON()),navigation:performance.getEntriesByType('navigation')[0].toJSON(),fontLinks:[...document.querySelectorAll('link[rel="stylesheet"]')].filter(e=>/fontshare|googleapis/.test(e.href)).map(e=>({href:e.href,media:e.media})),resources:performance.getEntriesByType('resource').map(e=>({url:e.name,start:e.startTime,duration:e.duration}))}));
 rows.push({label,target,iteration,readyMs,errors,fontRequests,...data}); console.log(JSON.stringify({label,target,iteration,readyMs,paints:data.paints,errors}));await writeFile(output,JSON.stringify({fontDelayMs:8000,profile:{latencyMs:100,downloadMbps:10,cpu:4},note:'Controlled font CSS fault injection, empty CSS response after 8 seconds. Top-page network throttle; iframe limitation applies.',runs:rows},null,2));
 }finally{await ctx.close()}
}}finally{await b.close()}
