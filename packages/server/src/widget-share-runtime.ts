// A visitor SDK has no member paths, document identity or bearer capability.
// It uses only the outer page's narrow read broker and tab-local state.
export function buildWidgetShareRuntimeScript(): string {
  const script = String.raw`(function(){
const cfg={mode:'share',runtimeVersion:'1.0-share'};
const post=window.parent.postMessage.bind(window.parent);
const navigationToken=Array.from(crypto.getRandomValues(new Uint32Array(4)),v=>v.toString(16).padStart(8,'0')).join('-');
const media=window.matchMedia('(prefers-color-scheme: dark)');
const theme=()=>document.documentElement.setAttribute('data-theme',media.matches?'dark':'light');
theme();media.addEventListener('change',theme);
let sequence=0;
const pending=new Map();
window.addEventListener('message',event=>{
  if(event.source!==window.parent)return;
  const value=event.data;
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
const ui={getTheme:()=>document.documentElement.getAttribute('data-theme'),getViewport:()=>({width:innerWidth,height:innerHeight}),notify:message=>window.dispatchEvent(new CustomEvent('worktable:notice',{detail:{message:String(message)}})),getDiagnostics:()=>[],reportDiagnostic:()=>{}};
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
post({type:'worktable.navigation.handshake',navigationToken},'*');
})();`
  return `<script data-worktable-runtime="sdk">${script.replace(/<\/script/gi, "<\\/script")}</script>`
}

export const SHARE_FONT_CSS = `
@font-face { font-family: "General Sans"; src: url("/gateway/assets/general-sans-variable.woff2") format("woff2"); font-style: normal; font-weight: 200 700; font-display: swap; }
@font-face { font-family: Fraunces; src: url("/gateway/assets/fraunces-variable-latin.woff2") format("woff2"); font-style: normal; font-weight: 300 900; font-display: swap; }
`
