// A visitor SDK has no member paths, document identity or bearer capability.
// It uses only the outer page's narrow read broker and tab-local state.
export function buildWidgetShareRuntimeScript(): string {
  const script = String.raw`(function(){
const cfg={mode:'share',runtimeVersion:'1.0-share'};
const post=window.parent.postMessage.bind(window.parent);
const navigationToken=Array.from(crypto.getRandomValues(new Uint32Array(4)),v=>v.toString(16).padStart(8,'0')).join('-');
const media=window.matchMedia('(prefers-color-scheme: dark)');
// The visitor's choice on the share page, named on the frame before this
// runs and sent when it changes; until then, the system's.
let chosen=(/^worktable-theme:(light|dark)$/.exec(window.name)||[])[1]||null;
const theme=()=>document.documentElement.setAttribute('data-theme',chosen||(media.matches?'dark':'light'));
theme();media.addEventListener('change',theme);
let sequence=0;
const pending=new Map();
window.addEventListener('message',event=>{
  if(event.source!==window.parent)return;
  const value=event.data;
  if(value&&value.type==='worktable.theme'&&(value.theme==='light'||value.theme==='dark')){chosen=value.theme;theme();return}
  if(!value||value.type!=='worktable.api.response'||typeof value.id!=='string')return;
  const done=pending.get(value.id);
  if(done){pending.delete(value.id);done(value)}
});
function fail(code,message){const error=new Error(message);error.code=code;return error}
function request(path,method,body){
  if(pending.size>=40)return Promise.reject(fail('LINK_BUSY','Too many requests. Try again in a moment.'));
  return new Promise((resolve,reject)=>{
    const serialized=body===undefined?null:JSON.stringify(body);
    const id='share-'+(++sequence);
    const timer=setTimeout(()=>{pending.delete(id);reject(fail('NETWORK_ERROR','The request timed out. Try again.'))},30000);
    pending.set(id,result=>{
      clearTimeout(timer);
      if(result.ok)resolve(result.body);
      else {const error=fail(result.body?.code||'BRIDGE_ERROR',result.body?.error||'Something went wrong. Try again.');error.status=result.status;reject(error)}
    });
    post({type:'worktable.api.request',id,method:method||'GET',path,body:serialized},'*');
  });
}
const readonly=()=>Promise.reject(fail('LINK_READ_ONLY','This link is view only.'));
const recordPath=collection=>'/link/records/'+encodeURIComponent(collection)+'/query';
// A burst of change hints becomes one query in flight and one trailing
// refresh, so a busy collection can't fill the broker's request slots.
function subscribe(collection,query,callback,detailed){
  let closed=false;
  let inFlight=false;
  let dirty=false;
  const load=()=>{
    if(closed)return;
    if(inFlight){dirty=true;return}
    inFlight=true;
    request(recordPath(collection),'POST',query||{})
      .then(result=>{if(!closed)callback(detailed?result:result.records)},error=>{if(!closed)console.error(error)})
      .finally(()=>{inFlight=false;if(dirty&&!closed){dirty=false;load()}});
  };
  const changed=event=>{if(event.source===window.parent&&event.data?.type==='worktable.records.changed'&&event.data.collection===collection)load()};
  window.addEventListener('message',changed);
  post({type:'worktable.subscribe',collection},'*');
  load();
  return()=>{closed=true;window.removeEventListener('message',changed);post({type:'worktable.unsubscribe',collection},'*')};
}
const records={
  query:(collection,query)=>request(recordPath(collection),'POST',query||{}).then(result=>result.records),
  queryDetailed:(collection,query)=>request(recordPath(collection),'POST',query||{}),
  create:readonly,update:readonly,delete:readonly,
  subscribe:(collection,query,callback)=>subscribe(collection,query,callback,false),
  subscribeDetailed:(collection,query,callback)=>subscribe(collection,query,callback,true)
};
// Writes read the state, then replace it: run them one at a time so two
// quick writes can't drop each other's changes.
let stateWrites=Promise.resolve();
function mutateState(action){const result=stateWrites.then(action);stateWrites=result.catch(()=>{});return result}
const state={
  get:async key=>{const result=await request('/link/state');return typeof key==='string'?result.state[key]:result.state},
  set:(key,value)=>mutateState(async()=>{
    const snapshot=await request('/link/state');
    const current=snapshot.visitorState||snapshot.state;
    const next=typeof key==='string'?{...current,[key]:value}:key&&typeof key==='object'?{...current,...key}:{};
    await request('/link/state','PUT',{state:next});
    return typeof key==='string'?value:key&&typeof key==='object'?{...snapshot.state,...next}:{};
  }),
  update:updater=>mutateState(async()=>{
    const snapshot=await request('/link/state');
    const next=await updater(snapshot.state)||{};
    if(typeof next!=='object'||Array.isArray(next))throw fail('INVALID_QUERY',"The state isn't valid.");
    const own=snapshot.visitorState||snapshot.state;
    const overlay=Object.create(null);
    for(const [key,value] of Object.entries(next))if(Object.hasOwn(own,key)||JSON.stringify(value)!==JSON.stringify(snapshot.state[key]))overlay[key]=value;
    await request('/link/state','PUT',{state:overlay});return next;
  })
};
// A page's notice shows to the visitor as a short message at the bottom of
// the page, drawn in its own shadow root so the page's styles leave it be.
// One shows at a time; the theme's colors reach it through the host.
let noticeHost=null,noticeBox=null,noticeTimer=0;
function showNotice(text,tone){
  if(!noticeHost){
    noticeHost=document.createElement('div');
    noticeHost.setAttribute('data-worktable-notice','');
    noticeHost.style.cssText='all:initial;position:fixed;left:0;right:0;bottom:16px;z-index:2147483647;display:flex;justify-content:center;pointer-events:none';
    const root=noticeHost.attachShadow({mode:'open'});
    const style=document.createElement('style');
    style.textContent='div{box-sizing:border-box;max-width:min(420px,calc(100vw - 32px));padding:10px 14px;border-radius:10px;border:1px solid var(--border,rgba(127,127,127,.3));background:var(--popover,#fff);color:var(--popover-foreground,var(--foreground,#111));font:500 14px/1.4 var(--font-sans,system-ui,sans-serif);box-shadow:0 6px 24px rgba(0,0,0,.18);overflow-wrap:anywhere}div[data-tone=error]{border-color:var(--destructive,#d33)}div[data-tone=warning]{border-color:var(--warning,#c80)}';
    noticeBox=document.createElement('div');
    noticeBox.setAttribute('role','status');
    noticeBox.setAttribute('aria-live','polite');
    root.append(style,noticeBox);
  }
  if(!noticeHost.isConnected)document.documentElement.appendChild(noticeHost);
  noticeBox.textContent=text;
  noticeBox.setAttribute('data-tone',tone);
  clearTimeout(noticeTimer);
  noticeTimer=setTimeout(()=>noticeHost.remove(),tone==='error'?6000:4000);
}
function noticeTone(options){const tone=options&&(options.tone||options.level||options.type);return tone==='error'||tone==='warning'||tone==='success'?tone:'info'}
const ui={getTheme:()=>document.documentElement.getAttribute('data-theme'),getViewport:()=>({width:innerWidth,height:innerHeight}),notify:(message,options)=>{
  const text=String(message==null?'':message).trim().slice(0,200);
  window.dispatchEvent(new CustomEvent('worktable:notice',{detail:{message:text}}));
  if(text)showNotice(text,noticeTone(options));
},getDiagnostics:()=>[],reportDiagnostic:()=>{}};
window.worktable={version:cfg.runtimeVersion,records,state,ui,navigation:{openDocument:()=>Promise.reject(fail('NOT_AVAILABLE','This link cannot open other documents.'))},diagnostics:{list:ui.getDiagnostics,report:ui.reportDiagnostic},toast:ui.notify};
window.agentdash=window.worktable;
// Gestures inside an opaque frame never bubble to the outer page.
let lastInteraction=0;
function interacted(event){if(!event.isTrusted||Date.now()-lastInteraction<1000)return;lastInteraction=Date.now();post({type:'worktable.interaction',navigationToken},'*')}
window.addEventListener('pointerdown',interacted,{passive:true});
window.addEventListener('keydown',interacted);
window.addEventListener('click',event=>{
  if(event.isTrusted){lastInteraction=Date.now();post({type:'worktable.interaction',navigationToken},'*')}
  const anchor=event.composedPath().find(node=>node instanceof HTMLAnchorElement);
  if(!anchor||!anchor.getAttribute('href')||anchor.getAttribute('href').startsWith('#'))return;
  let url;try{url=new URL(anchor.href)}catch{return}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return;
  event.preventDefault();
  if(!event.isTrusted)return;
  post({type:'worktable.share.open-link',url:url.href,navigationToken},'*');
},true);
window.addEventListener('submit',event=>event.preventDefault());
window.addEventListener('pagehide',()=>post({type:'worktable.navigation.frame-leaving',navigationToken},'*'));
// How far down the page has been read, for its owner's view counts: the page
// itself or, when it doesn't scroll, its largest scrolling area at least half
// the window tall.
let readDepth=0,depthTimer=0,scrolled=null;
const tall=node=>node instanceof Element&&node.clientHeight>=innerHeight/2&&node.scrollHeight>node.clientHeight+1;
function scrollingArea(root){
  if(scrolled!==root&&tall(scrolled))return scrolled;
  if(root.scrollHeight>innerHeight+1)return root;
  let best=null;const walker=document.createTreeWalker(document.body||root,NodeFilter.SHOW_ELEMENT);
  for(let node=walker.nextNode(),seen=0;node&&seen<5000;node=walker.nextNode(),seen++){
    if(tall(node)&&/auto|scroll/.test(getComputedStyle(node).overflowY)&&(!best||node.clientHeight>best.clientHeight))best=node;
  }
  return best||root;
}
function noteDepth(){
  const root=document.scrollingElement||document.documentElement;
  const area=scrollingArea(root);
  const seen=area===root?root.scrollTop+innerHeight:area.scrollTop+area.clientHeight;
  if(!area.scrollHeight)return;
  const depth=Math.min(100,Math.round(seen/area.scrollHeight*100));
  if(depth<readDepth+5&&!(depth===100&&readDepth<100))return;
  readDepth=depth;post({type:'worktable.view.scroll',navigationToken,depth},'*');
}
window.addEventListener('scroll',event=>{scrolled=event.target;if(!depthTimer)depthTimer=setTimeout(()=>{depthTimer=0;noteDepth()},250)},{passive:true,capture:true});
window.addEventListener('load',noteDepth);
post({type:'worktable.navigation.handshake',navigationToken},'*');
})();`
  return `<script data-worktable-runtime="sdk">${script.replace(/<\/script/gi, "<\\/script")}</script>`
}

export const SHARE_FONT_CSS = `
@font-face { font-family: "General Sans"; src: url("/gateway/assets/general-sans-variable.woff2") format("woff2"); font-style: normal; font-weight: 200 700; font-display: swap; }
@font-face { font-family: Fraunces; src: url("/gateway/assets/fraunces-variable-latin.woff2") format("woff2"); font-style: normal; font-weight: 300 900; font-display: swap; }
`
