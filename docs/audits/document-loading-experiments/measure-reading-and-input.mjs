// Run against an isolated production fixture. Never point the input check at
// a real document: it types one character and undoes it to verify live editing.
import { chromium } from 'playwright-core';
import { writeFile } from 'node:fs/promises';

const origin = process.env.AUDIT_ORIGIN;
if (!origin) throw new Error('AUDIT_ORIGIN must point to an isolated fixture server');
const output = process.env.AUDIT_OUTPUT || '/tmp/worktable-reading-and-input.json';
const browser = await chromium.connectOverCDP(process.env.AUDIT_CDP || 'http://127.0.0.1:18800');
const profiles = {
  normal: {latency: 100, downloadThroughput: 1250000, uploadThroughput: 500000, cpu: 4},
  constrained: {latency: 400, downloadThroughput: 200000, uploadThroughput: 93750, cpu: 4},
};
const rows = [];
const paintOpportunity = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
async function measure(page, target, temperature, profile) {
  const errors = [];
  const onError = error => errors.push(String(error));
  page.on('pageerror', onError);
  const start = Date.now();
  try {
    if (temperature === 'warm') await page.reload({waitUntil:'commit'});
    else await page.goto(`${origin}/spaces/loading-audit/documents/${target}`, {waitUntil:'commit'});
    if (target === 'html-audit') {
      await page.frameLocator('iframe[data-worktable-widget-frame]').getByRole('heading', {name:'Audit HTML ready'}).waitFor({timeout:90000});
      await page.getByRole('status', {name:'Opening document', exact:true}).waitFor({state:'hidden',timeout:90000});
    } else if (target === 'plain') {
      await page.locator('main .worktable-markdown').getByRole('heading', {name:'Audit Markdown'}).waitFor({timeout:90000});
    } else {
      const last = Number(target.split('-')[1]) - 1;
      await page.locator(`.bn-editor .bn-block-outer[data-id="p-${last}"]`).waitFor({state:'attached',timeout:90000});
      await page.waitForFunction(() => {
        const editor = document.querySelector('.bn-editor[contenteditable="true"]');
        return editor && !editor.closest('[inert]') && !document.querySelector('[data-document-preview]');
      }, undefined, {timeout:90000});
    }
    await page.waitForFunction(() => !document.getElementById('worktable-opening-preview')?.childElementCount);
    await paintOpportunity(page);
    const readyMs = Date.now() - start;
    let input = null;
    if (target.startsWith('rich-')) {
      const first = page.locator('.bn-editor .bn-block-outer[data-id="p-0"] .bn-inline-content').first();
      const previous = await first.innerText();
      await first.click();
      await page.keyboard.press('End');
      const inputStart = await page.evaluate(() => performance.now());
      await page.keyboard.press('x');
      await paintOpportunity(page);
      const inputEnd = await page.evaluate(() => performance.now());
      if (!((await first.innerText()).includes('x'))) throw new Error('Typed character not present');
      await page.keyboard.press('Control+z');
      if ((await first.innerText()) !== previous) throw new Error('Undo did not restore fixture text');
      input = {automationToPaintOpportunityMs:inputEnd-inputStart};
    }
    const data = await page.evaluate(() => ({
      previewPaintOpportunityMs:window.__openingMetrics.preview,
      navigation:performance.getEntriesByType('navigation')[0].toJSON(),
      paints:performance.getEntriesByType('paint').map(entry=>entry.toJSON()),
      longTasks:window.__openingMetrics.longTasks,
      interactions:window.__openingMetrics.interactions,
      transferredBytes:performance.getEntriesByType('resource').reduce((sum,entry)=>sum+entry.transferSize,0),
    }));
    rows.push({target,temperature,profile,readyMs,input,errors,...data});
    console.log(JSON.stringify({target,temperature,profile,readyMs,preview:data.previewPaintOpportunityMs,input,errors}));
  } catch(error) {
    rows.push({target,temperature,profile,elapsedMs:Date.now()-start,failure:String(error),errors});
    console.log(JSON.stringify(rows.at(-1)));
  } finally {
    page.off('pageerror',onError);
    await writeFile(output, JSON.stringify({origin,profiles,note:'Single-session event durations are diagnostics, not field INP. Warm means a same-context reload after the cold opening and typing/undo check.',runs:rows},null,2));
  }
}
try {
  for (const profile of (process.env.AUDIT_PROFILES || 'normal,constrained').split(',')) {
    for (const target of (process.env.AUDIT_TARGETS || 'rich-10,rich-2000,plain,html-audit').split(',')) {
      const context = await browser.newContext({viewport:{width:1280,height:900}});
      try {
        if (process.env.AUDIT_PASSWORD) {
          const response = await context.request.post(`${origin}/auth/login`, {data:{password:process.env.AUDIT_PASSWORD},headers:{Origin:origin}});
          if (!response.ok()) throw new Error(`Fixture login failed: ${response.status()}`);
        }
        const page = await context.newPage();
        await page.bringToFront();
        const cdp = await context.newCDPSession(page);
        const {cpu,...network} = profiles[profile];
        await cdp.send('Network.enable');
        await cdp.send('Network.emulateNetworkConditions',{offline:false,...network});
        await cdp.send('Emulation.setCPUThrottlingRate',{rate:cpu});
        await page.addInitScript(() => {
          if (window !== window.top) return;
          localStorage.setItem('theme','dark');
          const metrics = window.__openingMetrics = {preview:null,longTasks:[],interactions:[]};
          const observer = new MutationObserver(() => {
            if (!document.querySelector('[data-document-preview]')) return;
            observer.disconnect();
            requestAnimationFrame(()=>requestAnimationFrame(()=>{metrics.preview=performance.now()}));
          });
          observer.observe(document,{childList:true,subtree:true});
          new PerformanceObserver(list=>metrics.longTasks.push(...list.getEntries().map(entry=>({start:entry.startTime,duration:entry.duration})))).observe({type:'longtask',buffered:true});
          new PerformanceObserver(list=>metrics.interactions.push(...list.getEntries().filter(entry=>entry.interactionId).map(entry=>({name:entry.name,start:entry.startTime,duration:entry.duration,interactionId:entry.interactionId})))).observe({type:'event',buffered:true,durationThreshold:16});
        });
        await measure(page,target,'cold',profile);
        if (!rows.at(-1)?.failure) await measure(page,target,'warm',profile);
      } finally { await context.close(); }
    }
  }
} finally { await browser.close(); }
