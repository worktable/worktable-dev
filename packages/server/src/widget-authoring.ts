import type { WidgetFile } from "@worktable/types"
import { parseDocument, Parser } from "htmlparser2"

export type WidgetTheme = "light" | "dark"

export type WidgetValidationSeverity = "hint" | "warning" | "error"

export type WidgetSuggestedPermissions = Partial<
  Pick<WidgetFile["permissions"], "network" | "records" | "state">
>

export type WidgetValidationIssue = {
  severity: WidgetValidationSeverity
  code: string
  message: string
  hint?: string
  suggestedPermissions?: WidgetSuggestedPermissions
}

const EXTERNAL_ASSET_URL_RE =
  /(?:\bsrc\s*=\s*["']https?:\/\/|<(?!a\b)[^>]*\bhref\s*=\s*["']https?:\/\/)/i
const EXTERNAL_CSS_URL_RE = /url\(\s*["']?https?:\/\//i
const EXTERNAL_JS_URL_RE = /\b(?:fetch|import)\s*\(\s*["']https?:\/\//i
const EXTERNAL_CSS_RE = /<link\b[^>]*rel\s*=\s*["']stylesheet["'][^>]*>/i
const EXTERNAL_SCRIPT_RE = /<script\b[^>]*\bsrc\s*=/i
const INLINE_EVENT_HANDLER_RE = /\son[a-z]+\s*=/i
const FORM_TAG_RE = /<form\b/i
const BROWSER_STORAGE_RE = /\b(?:localStorage|sessionStorage|indexedDB)\b/i
const RAW_FETCH_RE = /\bfetch\s*\(/i
const DIRECT_WORKTABLE_API_FETCH_RE = /\bfetch\s*\(\s*['"]\/api\//i
const RECORD_CALL_RE =
  /\bworktable\s*\.\s*records\s*\.\s*(queryDetailed|query|create|update|delete|subscribeDetailed|subscribe)\s*\(\s*(["'`])([^"'`]+)\2/g
const ANY_RECORD_CALL_RE =
  /\bworktable\s*\.\s*records\s*\.\s*(queryDetailed|query|create|update|delete|subscribeDetailed|subscribe)\s*\(/g

type WidgetRecordAction = "read" | "create" | "update" | "delete"

const RECORD_ACTION_PERMISSIONS: Record<string, WidgetRecordAction[]> = {
  query: ["read"],
  queryDetailed: ["read"],
  subscribe: ["read"],
  subscribeDetailed: ["read"],
  create: ["create"],
  update: ["update"],
  delete: ["delete"],
}

const REQUIRED_THEME_TOKENS = [
  "--ad-bg",
  "--ad-surface",
  "--ad-text",
  "--ad-muted",
  "--ad-border",
  "--ad-accent",
] as const

export type BuildWidgetFileInput = {
  id: string
  name: string
  description?: string
  createdBy?: string
  updatedBy?: string
  metadata?: Record<string, unknown>
  permissions?: WidgetFile["permissions"]
  existing?: WidgetFile
  now?: string
}

export const WIDGET_STYLE_TOKENS = [
  "--ad-bg",
  "--ad-surface",
  "--ad-surface-2",
  "--ad-text",
  "--ad-muted",
  "--ad-border",
  "--ad-accent",
  "--ad-accent-soft",
  "--ad-danger",
  "--ad-warning",
  "--ad-success",
  "--ad-radius",
  "--ad-shadow",
] as const

export type HtmlGuideProfile = "runtime"

export const HTML_GUIDE_SHARED = `# Worktable HTML Doc Authoring

HTML Docs are complete, self-contained documents rendered in a sandbox inside a Worktable Space. Each document includes doctype, html, head, viewport metadata, and body. External scripts, stylesheets, fonts, images, and other http/https assets are not supported; ordinary links are supported, and inline SVG, CSS, data URLs, and local HTML/JavaScript remain inside the artifact.`

export const HTML_GUIDE_RUNTIME = `## Runtime and data contract

Records hold canonical shared data. worktable.state holds HTML-Doc-local UI state such as filters, drafts, preferences, and selections. Browser storage is not a supported persistence contract, and direct /api fetches are not a supported Worktable data interface.

The parent theme is available through these semantic variables:
${WIDGET_STYLE_TOKENS.join(", ")}.

Documents can define default/light values and html[data-theme="dark"] overrides, and can declare color-scheme: light dark.

Available APIs:
- worktable.records.query(collectionId, query?)
- worktable.records.queryDetailed(collectionId, query?)
- worktable.records.create(collectionId, data, options?)
- worktable.records.update(collectionId, recordId, patch)
- worktable.records.delete(collectionId, recordId)
- worktable.records.subscribe(collectionId, query?, callback)
- worktable.records.subscribeDetailed(collectionId, query?, callback)
- worktable.state.get(key?)
- worktable.state.set(key, value) or worktable.state.set(patch)
- worktable.state.update(async current => nextState)
- worktable.navigation.openDocument(path)
- worktable.ui.notify(message, options?)
- worktable.ui.getTheme()
- worktable.ui.getViewport()
- worktable.diagnostics.report({ level, code, message, hint, detail })

Every worktable.records call requires explicit per-collection permissions. Cross-collection expansion, backlinks, and relation-path filters also require read permission on target collections. Worktable warns when literal calls reveal missing permissions; dynamic collection ids require explicit coverage.

Outbound fetch requires network permission. Without permission, the sandbox blocks it. Runtime APIs are brokered through the parent and do not need network permission.

openDocument accepts a Space-root document path such as plans/brief and must be called from a button or link click. Worktable follows moved-path aliases and opens the canonical document. Docs with registered viewers use their specialized view; other supported formats open a read-only download fallback. Missing or conflicting documents reject without leaving the current HTML Doc.

addEventListener is supported for interaction. Buttons default to form submission unless type="button" is set. Forms cannot navigate the sandbox safely; submit handlers can persist through Records or state. Inline event handlers are accepted with a warning.

Narrative Doc writes validate Mermaid automatically. HTML cannot reliably expose Mermaid embedded in arbitrary markup or JavaScript. worktable_mermaid action "validate" accepts raw Mermaid source, while action "preview" also returns an SVG that can be embedded.`

export function getHtmlAuthoringGuide(
  _profile: HtmlGuideProfile = "runtime"
): string {
  return `${HTML_GUIDE_SHARED}\n\n${HTML_GUIDE_RUNTIME}`
}

function hasRecordPermission(
  permissions: WidgetFile["permissions"] | undefined,
  collectionId: string,
  action: WidgetRecordAction
): boolean {
  const recordPermissions = permissions?.records ?? {}
  return !!(
    recordPermissions[collectionId]?.[action] ??
    recordPermissions["*"]?.[action]
  )
}

export function inferWidgetRecordPermissions(
  html: string
): Record<string, Partial<Record<WidgetRecordAction, true>>> {
  const inferred: Record<string, Partial<Record<WidgetRecordAction, true>>> = {}
  for (const match of html.matchAll(RECORD_CALL_RE)) {
    const method = match[1]
    const collectionId = match[3]
    if (!method || !collectionId) continue
    for (const action of RECORD_ACTION_PERMISSIONS[method] ?? []) {
      inferred[collectionId] ??= {}
      inferred[collectionId][action] = true
    }
  }
  return inferred
}

function addRecordPermissionWarnings(
  html: string,
  permissions: WidgetFile["permissions"] | undefined,
  issues: WidgetValidationIssue[]
): void {
  const inferred = inferWidgetRecordPermissions(html)
  for (const [collectionId, actions] of Object.entries(inferred)) {
    const missing = (Object.keys(actions) as WidgetRecordAction[]).filter(
      (action) => !hasRecordPermission(permissions, collectionId, action)
    )
    if (missing.length === 0) continue
    issues.push({
      severity: "warning",
      code: "missing_record_permission",
      message: `Widget uses worktable.records for '${collectionId}' but is missing ${missing.join(", ")} permission${missing.length === 1 ? "" : "s"}.`,
      hint: `Add ${missing.map((action) => `permissions.records.${collectionId}.${action} = true`).join(" and ")}, or remove the matching worktable.records call.`,
      suggestedPermissions: {
        records: {
          [collectionId]: Object.fromEntries(
            missing.map((action) => [action, true])
          ),
        },
      },
    })
  }

  const literalCalls = Object.values(inferred).reduce(
    (count, actions) => count + Object.keys(actions).length,
    0
  )
  const totalCalls = Array.from(html.matchAll(ANY_RECORD_CALL_RE)).length
  if (totalCalls > 0 && literalCalls === 0) {
    issues.push({
      severity: "hint",
      code: "dynamic_record_collection",
      message:
        "Widget uses worktable.records with a dynamic collection id, so Worktable cannot infer record permissions.",
      hint: "Declare explicit permissions.records entries for every collection the widget may access.",
    })
  }
}

export function validateWidgetHtml(
  html: string,
  permissions?: WidgetFile["permissions"]
): WidgetValidationIssue[] {
  const issues: WidgetValidationIssue[] = []
  if (!/<meta\b[^>]*name\s*=\s*["']viewport["']/i.test(html)) {
    issues.push({
      severity: "hint",
      code: "missing_viewport",
      message:
        "Widget should include a viewport meta tag for mobile rendering.",
    })
  }
  if (EXTERNAL_SCRIPT_RE.test(html)) {
    issues.push({
      severity: "error",
      code: "external_script",
      message: "External script sources are not allowed in widgets.",
    })
  }
  if (EXTERNAL_CSS_RE.test(html)) {
    issues.push({
      severity: "error",
      code: "external_stylesheet",
      message: "External stylesheets are not allowed in widgets.",
    })
  }
  if (
    EXTERNAL_ASSET_URL_RE.test(html) ||
    EXTERNAL_CSS_URL_RE.test(html) ||
    EXTERNAL_JS_URL_RE.test(html)
  ) {
    issues.push({
      severity: "error",
      code: "external_asset",
      message: "External http/https assets are not allowed in widgets.",
    })
  }
  if (FORM_TAG_RE.test(html)) {
    issues.push({
      severity: "warning",
      code: "form_submit_sandbox",
      message:
        "Forms are rendered in a sandbox. Worktable will prevent unsafe page submission; prefer JS submit handlers or button actions.",
    })
  }
  if (BROWSER_STORAGE_RE.test(html)) {
    issues.push({
      severity: "warning",
      code: "browser_storage",
      message:
        "Browser storage can be unavailable or temporary in widget sandboxes. Prefer worktable.state for widget-local state.",
    })
  }
  if (RAW_FETCH_RE.test(html)) {
    const isDirectApi = DIRECT_WORKTABLE_API_FETCH_RE.test(html)
    const rawFetchMessage = permissions?.network
      ? "This widget makes external fetch calls; the network permission is granted so they are allowed. Handle failures gracefully."
      : "Raw fetch calls to external origins are blocked by the sandbox unless the network permission is granted. Prefer Worktable runtime APIs, or request network access."
    issues.push({
      severity: "warning",
      code: isDirectApi ? "direct_worktable_api_fetch" : "raw_fetch",
      message: isDirectApi
        ? "Prefer worktable.records or worktable.state over direct fetches to Worktable's own REST API."
        : rawFetchMessage,
    })
  }
  if (INLINE_EVENT_HANDLER_RE.test(html)) {
    issues.push({
      severity: "hint",
      code: "inline_event_handler",
      message:
        "Prefer addEventListener over inline on* handlers for maintainability and CSP compatibility.",
    })
  }
  if (!/html\s*\[\s*data-theme\s*=\s*["']dark["']\s*\]/i.test(html)) {
    issues.push({
      severity: "hint",
      code: "missing_dark_theme",
      message: 'Widget should include html[data-theme="dark"] CSS overrides.',
    })
  }
  for (const token of REQUIRED_THEME_TOKENS) {
    if (!html.includes(token)) {
      issues.push({
        severity: "hint",
        code: `missing_token_${token.slice(5)}`,
        message: `Widget should define and use ${token}.`,
      })
    }
  }
  addRecordPermissionWarnings(html, permissions, issues)
  return issues
}

export function getBlockingWidgetIssue(
  issues: WidgetValidationIssue[]
): WidgetValidationIssue | undefined {
  return issues.find((issue) => issue.severity === "error")
}

export function buildWidgetFile({
  id,
  name,
  description,
  createdBy = "agent",
  updatedBy = "agent",
  metadata,
  permissions,
  existing,
  now = new Date().toISOString(),
}: BuildWidgetFileInput): WidgetFile {
  if (existing) {
    return {
      ...existing,
      name,
      description,
      updatedAt: now,
      updatedBy,
      metadata: metadata ?? existing.metadata,
      permissions: permissions ?? existing.permissions,
    }
  }

  return {
    version: 1,
    kind: "worktable.widget",
    id,
    name,
    description,
    createdAt: now,
    updatedAt: now,
    createdBy,
    archive: null,
    metadata: metadata ?? {},
    runtime: { type: "html", entry: "index.html" },
    permissions: permissions ?? {
      network: false,
      records: {},
      state: { read: true, write: true },
    },
  }
}

function normalizeTheme(theme: string | null | undefined): WidgetTheme {
  return theme === "light" ? "light" : "dark"
}

export function applyWidgetTheme(
  html: string,
  themeInput?: string | null
): string {
  const theme = normalizeTheme(themeInput)
  if (/<html\b[^>]*data-theme\s*=/.test(html)) {
    return html.replace(
      /<html\b([^>]*)data-theme\s*=\s*["'][^"']*["']([^>]*)>/i,
      `<html$1data-theme="${theme}"$2>`
    )
  }
  if (/<html\b/i.test(html)) {
    return html.replace(/<html\b([^>]*)>/i, `<html$1 data-theme="${theme}">`)
  }
  return `<!doctype html><html data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${html}</body></html>`
}

function escapeClosingScript(value: string): string {
  return value.replace(/<\/script/gi, "<\\/script")
}

export function buildWidgetHostStyles(): string {
  return `<style data-worktable-runtime="host-smoothness">
:root { color-scheme: light dark; }
html { min-height: 100%; }
body { min-height: 100%; -webkit-text-size-adjust: 100%; text-rendering: optimizeLegibility; }
*, *::before, *::after { box-sizing: border-box; }
button, input, select, textarea { font: inherit; }
button, [role="button"], input, select, textarea, summary { -webkit-tap-highlight-color: transparent; }
button, [role="button"], input[type="button"], input[type="submit"], input[type="reset"], input[type="range"], input[type="checkbox"], input[type="radio"], select, summary { touch-action: manipulation; }
input[type="range"] { cursor: pointer; }
:focus-visible { outline: 2px solid var(--ad-accent, Highlight); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; scroll-behavior: auto !important; transition-duration: 0.01ms !important; }
}
</style>`
}

export function buildWidgetRuntimeScript(
  spaceId: string,
  widgetId: string
): string {
  const apiBase = `/api/spaces/${encodeURIComponent(spaceId)}/widgets/__document/${Buffer.from(widgetId, "utf8").toString("base64url")}`
  const config = JSON.stringify({
    spaceId,
    widgetId,
    apiBase,
    runtimeVersion: "2.0-smooth",
  })
  const script = `(function(){
const cfg=${config};
const originalFetch=typeof window.fetch==='function'?window.fetch.bind(window):async function(){throw new Error('fetch is not available in this widget runtime')};
// This closure runs before authored scripts. Its token lets the parent distinguish
// the gesture-gated SDK from authored code posting the broker message directly.
const postToParent=window.parent.postMessage.bind(window.parent);
const navigationToken=Array.from(crypto.getRandomValues(new Uint32Array(4)),function(value){return value.toString(16).padStart(8,'0')}).join('-');
const userActivation=navigator.userActivation;
const userActivationGetter=userActivation&&Object.getOwnPropertyDescriptor(Object.getPrototypeOf(userActivation),'isActive')?.get;
const eventIsTrustedGetter=Object.getOwnPropertyDescriptor(Event.prototype,'isTrusted')?.get;
const nativeApply=Reflect.apply;
const enqueueMicrotask=typeof queueMicrotask==='function'?queueMicrotask.bind(window):function(callback){Promise.resolve().then(callback)};
let trustedClickInProgress=false;
window.addEventListener('click',function(event){
  let trusted=false;
  try{trusted=typeof eventIsTrustedGetter==='function'&&nativeApply(eventIsTrustedGetter,event,[])===true}catch{}
  if(!trusted)return;
  trustedClickInProgress=true;
  enqueueMicrotask(function(){trustedClickInProgress=false});
},true);
function hasActiveUserGesture(){
  if(typeof userActivationGetter==='function'){
    try{if(nativeApply(userActivationGetter,userActivation,[])===true)return true}catch{}
  }
  return trustedClickInProgress;
}
const diagnostics=[];
let diagnosticSeq=0;
function now(){try{return new Date().toISOString()}catch{return String(Date.now())}}
function emitDiagnostic(level,code,message,hint,detail){
  const diagnostic={id:'wd-'+(++diagnosticSeq),level,code,message,hint,detail:detail||null,timestamp:now()};
  diagnostics.push(diagnostic);
  try{window.dispatchEvent(new CustomEvent('worktable:diagnostic',{detail:diagnostic}))}catch{}
  try{window.parent&&window.parent.postMessage({type:'worktable.widget.diagnostic',widgetId:cfg.widgetId,diagnostic},'*')}catch{}
  if(level==='error') console.error('[Worktable widget]',message,hint||'',detail||'');
  else if(level==='warning') console.warn('[Worktable widget]',message,hint||'',detail||'');
  else console.info('[Worktable widget]',message,hint||'',detail||'');
  return diagnostic;
}
window.__worktableDiagnostics=diagnostics;
window.addEventListener('error',function(event){emitDiagnostic('error','runtime_error',event.message||'Widget runtime error','Check the widget script around this stack trace.',{filename:event.filename,lineno:event.lineno,colno:event.colno})});
window.addEventListener('unhandledrejection',function(event){emitDiagnostic('error','unhandled_rejection','Widget promise rejected','Handle async errors inside the widget.',{reason:String(event.reason&&event.reason.message||event.reason)})});
function permissionHint(body,fallback){
  if(body&&body.missingPermission) return 'Add '+body.missingPermission+' = true to this widget permissions.';
  return fallback||'Check widget permissions and the Worktable runtime API call.';
}
// Broker Worktable REST through the PARENT window instead of fetching from inside
// the sandboxed iframe. The iframe has an opaque origin (sandbox="allow-scripts",
// no allow-same-origin), so a direct credentialed /api fetch sends Origin: null and
// is blocked by the same-origin CORS policy when the install is exposed (and a
// SameSite cookie wouldn't attach). The parent is same-origin + authenticated, so it
// fetches on the widget's behalf; it allowlists the widget's own paths only.
const __wtPending={};let __wtSeq=0;
window.addEventListener('message',function(event){
  if(event.source!==window.parent) return;
  const d=event.data;
  if(!d||(d.type!=='worktable.api.response'&&d.type!=='worktable.navigation.response')||typeof d.id!=='string') return;
  const cb=__wtPending[d.id]; if(!cb) return; delete __wtPending[d.id]; cb(d);
});
postToParent({type:'worktable.navigation.handshake',widgetId:cfg.widgetId,spaceId:cfg.spaceId,navigationToken:navigationToken},'*');
// Reveal parsed markup without waiting for images or other non-blocking assets.
function announceDocumentReady(){
  postToParent({type:'worktable.document.ready',widgetId:cfg.widgetId,spaceId:cfg.spaceId,navigationToken:navigationToken},'*');
}
if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',announceDocumentReady,{once:true});
else queueMicrotask(announceDocumentReady);
function revokeNavigationAuthority(){
  postToParent({type:'worktable.navigation.frame-leaving',widgetId:cfg.widgetId,spaceId:cfg.spaceId,navigationToken:navigationToken},'*');
}
window.addEventListener('beforeunload',revokeNavigationAuthority);
window.addEventListener('pagehide',revokeNavigationAuthority);
function brokerParent(type,payload){
  return new Promise(function(resolve,reject){
    const id='wapi-'+(++__wtSeq)+'-'+Math.random().toString(36).slice(2);
    const timer=setTimeout(function(){if(__wtPending[id]){delete __wtPending[id];reject(new Error('Worktable request timed out'))}},30000);
    __wtPending[id]=function(res){clearTimeout(timer);resolve(res)};
    try{postToParent({type:type,id:id,widgetId:cfg.widgetId,spaceId:cfg.spaceId,...payload},'*')}
    catch(e){clearTimeout(timer);delete __wtPending[id];reject(e)}
  });
}
function brokerApi(path,opts){return brokerParent('worktable.api.request',{path:path,method:(opts&&opts.method)||'GET',body:(opts&&opts.body!==undefined)?opts.body:null})}
async function req(path,opts,context){
  const res=await brokerApi(path,opts);
  const body=(res&&res.body)||{};
  if(!res||!res.ok){
    const status=(res&&res.status)||0;
    const err=new Error(body.error||('HTTP '+status));
    err.code=body.code||'HTTP_ERROR';
    err.status=status;
    err.missingPermission=body.missingPermission;
    err.suggestedPermissions=body.suggestedPermissions;
    const code=body.missingPermission?'missing_widget_permission':err.code;
    emitDiagnostic(status>=500?'error':'warning',code,err.message,permissionHint(body),{path,status,missingPermission:body.missingPermission||null,suggestedPermissions:body.suggestedPermissions||null,context:context||null});
    throw err;
  }
  return body;
}
function isWorktableApiUrl(input){
  try{const value=typeof input==='string'?input:(input&&input.url)||'';return value.indexOf('/api/')===0||value.indexOf(location.origin+'/api/')===0}catch{return false}
}
window.fetch=function(input,init){
  if(isWorktableApiUrl(input)) emitDiagnostic('warning','direct_worktable_api_fetch','This widget called Worktable REST directly.','Prefer worktable.records, worktable.state, or a brokered runtime API so permissions and errors stay smooth.',{input:String(typeof input==='string'?input:(input&&input.url)||'')});
  return originalFetch(input,init);
};
window.addEventListener('submit',function(event){
  if(event.defaultPrevented) return;
  event.preventDefault();
  emitDiagnostic('warning','form_submit_intercepted','A form submit was kept inside the widget instead of navigating away.','Attach a submit handler that saves through worktable.records/state, or use button type="button" for app actions.');
});
function normalizeStateSetArgs(key,value){
  if(typeof key==='string') return {mode:'key',key,value};
  if(key&&typeof key==='object') return {mode:'patch',patch:key};
  return {mode:'replace',state:{}};
}
const records={
  query:(collection,query)=>req(cfg.apiBase+'/records/'+collection+'/query',{method:'POST',body:JSON.stringify(query||{})},{api:'records',collection,action:'read'}).then(r=>r.records),
  queryDetailed:(collection,query)=>req(cfg.apiBase+'/records/'+collection+'/query',{method:'POST',body:JSON.stringify(query||{})},{api:'records',collection,action:'read'}),
  create:(collection,data,opts)=>req(cfg.apiBase+'/records/'+collection,{method:'POST',body:JSON.stringify({data,id:opts&&opts.id,metadata:opts&&opts.metadata})},{api:'records',collection,action:'create'}).then(r=>r.record),
  update:(collection,id,patch)=>req(cfg.apiBase+'/records/'+collection+'/'+id,{method:'PATCH',body:JSON.stringify({data:patch})},{api:'records',collection,action:'update',recordId:id}).then(r=>r.record),
  delete:(collection,id)=>req(cfg.apiBase+'/records/'+collection+'/'+id,{method:'DELETE'},{api:'records',collection,action:'delete',recordId:id}),
  subscribe:(collection,query,callback)=>subscribeWith(collection,query,callback,(c,q)=>records.query(c,q)),
  subscribeDetailed:(collection,query,callback)=>subscribeWith(collection,query,callback,(c,q)=>records.queryDetailed(c,q)),
};
function subscribeWith(collection,query,callback,fetcher){let closed=false;async function load(){if(closed)return;callback(await fetcher(collection,query||{}))}load().catch(err=>emitDiagnostic('error','record_subscribe_load_failed',err.message,'Check record read permissions.',{collection}));
  // Live updates are relayed through the PARENT window. The sandboxed iframe's own
  // WebSocket would be rejected when exposed (null Origin), so the parent (which
  // holds a working same-origin space subscription) forwards record-change events.
  function onChange(event){if(event.source!==window.parent)return;const d=event.data;if(d&&d.type==='worktable.records.changed'&&d.collection===collection&&!closed){load().catch(err=>emitDiagnostic('error','record_subscribe_reload_failed',err.message,'Check record read permissions.',{collection}))}}
  window.addEventListener('message',onChange);
  try{window.parent.postMessage({type:'worktable.subscribe',widgetId:cfg.widgetId,spaceId:cfg.spaceId,collection:collection},'*')}catch(e){}
  return()=>{closed=true;window.removeEventListener('message',onChange);try{window.parent.postMessage({type:'worktable.unsubscribe',widgetId:cfg.widgetId,spaceId:cfg.spaceId,collection:collection},'*')}catch(e){}}}
const state={
  get:async(key)=>{const r=await req(cfg.apiBase+'/state',undefined,{api:'state',action:'read'});return key?r.state[key]:r.state},
  set:async(key,value)=>{const args=normalizeStateSetArgs(key,value);const r=await req(cfg.apiBase+'/state',undefined,{api:'state',action:'read'});const next=args.mode==='key'?{...r.state,[args.key]:args.value}:args.mode==='patch'?{...r.state,...args.patch}:args.state;await req(cfg.apiBase+'/state',{method:'PUT',body:JSON.stringify({state:next})},{api:'state',action:'write'});return args.mode==='key'?args.value:next},
  update:async(updater)=>{const current=await state.get();const next=await updater(current);await req(cfg.apiBase+'/state',{method:'PUT',body:JSON.stringify({state:next||{}})},{api:'state',action:'write'});return next||{}},
};
const navigation={
  openDocument:async(path)=>{
    const supplied=typeof path==='string'?path:'';
    if(!supplied.trim()){
      const err=new Error('Document path is required.');
      err.code='VALIDATION_ERROR';
      emitDiagnostic('warning','document_navigation_failed',err.message,'Use a Space-root path such as plans/brief.',{path:path});
      throw err;
    }
    if(!hasActiveUserGesture()){
      const err=new Error('Open documents from a user action.');
      err.code='USER_ACTION_REQUIRED';
      emitDiagnostic('warning','document_navigation_failed',err.message,'Call openDocument from a button or link click.',{path:supplied});
      throw err;
    }
    let res;
    try{res=await brokerParent('worktable.navigation.open-document',{path:supplied,navigationToken:navigationToken})}
    catch(error){
      emitDiagnostic('warning','document_navigation_failed','Could not open document.','Try again.',{path:supplied,error:String(error&&error.message||error)});
      throw error;
    }
    const body=(res&&res.body)||{};
    if(!res||!res.ok){
      const err=new Error(body.error||'Could not open document.');
      err.code=body.code||'NAVIGATION_ERROR';
      err.status=(res&&res.status)||0;
      emitDiagnostic('warning','document_navigation_failed',err.message,'Check the document path and try again.',{path:supplied,status:err.status,code:err.code});
      throw err;
    }
    return body.target;
  },
};
const ui={
  notify:(message,options)=>{emitDiagnostic(options&&options.level||'info','widget_notice',String(message),undefined,options||null)},
  getDiagnostics:()=>diagnostics.slice(),
  reportDiagnostic:(diagnostic)=>emitDiagnostic(diagnostic&&diagnostic.level||'warning',diagnostic&&diagnostic.code||'widget_report',diagnostic&&diagnostic.message||'Widget reported a diagnostic',diagnostic&&diagnostic.hint,diagnostic&&diagnostic.detail),
  getTheme:()=>document.documentElement.getAttribute('data-theme')||'dark',
  getViewport:()=>({width:window.innerWidth,height:window.innerHeight}),
};
window.worktable={version:cfg.runtimeVersion,records,state,navigation,ui,diagnostics:{list:ui.getDiagnostics,report:ui.reportDiagnostic},toast:ui.notify};
// Interaction ping: user gestures inside the sandboxed frame never bubble to
// the parent window, so inferred review ("reading = review" needs dwell AND an
// interaction) would otherwise never fire for HTML docs. Post a throttled,
// content-free signal the parent route counts as interaction.

// Back-compat: widgets authored before the AgentDash -> Worktable rename call agentdash.*.
// The runtime always binds worktable.*; alias the legacy global so those shipped
// widgets keep working. (CSS tokens stay --ad-* for the same reason.)
window.agentdash=window.worktable;window.__agentdashDiagnostics=diagnostics;
})();`
  return `<script data-worktable-runtime="sdk">${escapeClosingScript(script)}</script>`
}

export function injectWidgetRuntime(
  html: string,
  spaceId: string,
  widgetId: string
): string {
  const runtime = buildWidgetRuntimeScript(spaceId, widgetId)
  const runtimeInsertionIndex = trustedRuntimeInsertionIndex(html)
  let output = `${html.slice(0, runtimeInsertionIndex)}${runtime}${html.slice(runtimeInsertionIndex)}`
  let shell = inspectWidgetHtmlShell(output)
  if (!shell.hasViewport) {
    const viewport = `<meta name="viewport" content="width=device-width, initial-scale=1">`
    const insertionIndex =
      shell.headCloseStart ??
      shell.headOpenEnd ??
      trustedRuntimeInsertionIndex(output)
    output = `${output.slice(0, insertionIndex)}${viewport}${output.slice(insertionIndex)}`
    shell = inspectWidgetHtmlShell(output)
  }
  const hostStyles = buildWidgetHostStyles()
  if (shell.headOpenEnd !== null) {
    // Host styles remain last so their safety rails keep the existing cascade.
    if (shell.headCloseStart !== null) {
      output = `${output.slice(0, shell.headCloseStart)}${hostStyles}${output.slice(shell.headCloseStart)}`
    } else {
      output = `${output}${hostStyles}`
    }
    return output
  }
  return `${output}${hostStyles}`
}

function trustedRuntimeInsertionIndex(html: string): number {
  const document = parseDocument(html, {
    withStartIndices: true,
    withEndIndices: true,
  })
  const doctypeIndex = document.children.findIndex(
    (node) => "name" in node && node.name.toLowerCase() === "!doctype"
  )
  if (doctypeIndex < 0) return 0
  const precedingContentIsInert = document.children
    .slice(0, doctypeIndex)
    .every(
      (node) =>
        node.type === "comment" ||
        node.type === "directive" ||
        (node.type === "text" && "data" in node && node.data.trim() === "")
    )
  const doctypeEnd = document.children[doctypeIndex]?.endIndex
  return precedingContentIsInert &&
    doctypeEnd !== null &&
    doctypeEnd !== undefined
    ? doctypeEnd + 1
    : 0
}

function inspectWidgetHtmlShell(html: string): {
  headOpenEnd: number | null
  headCloseStart: number | null
  hasViewport: boolean
} {
  const document = parseDocument(html, {
    withStartIndices: true,
    withEndIndices: true,
  })
  type ParsedNode = (typeof document.children)[number]
  const isNamedElement = (
    node: ParsedNode,
    name: string
  ): node is ParsedNode & { name: string; children: ParsedNode[] } =>
    "name" in node && "children" in node && node.name === name
  const htmlElement = document.children.find((node) =>
    isNamedElement(node, "html")
  )
  const shellChildren = htmlElement?.children ?? document.children
  const headElement = shellChildren.find((node) => isNamedElement(node, "head"))
  const shellHeadStart = headElement?.startIndex ?? null
  const shellHeadEnd = headElement?.endIndex ?? null
  let headOpenEnd: number | null = null
  let headCloseStart: number | null = null
  let hasViewport = false
  let parser: Parser
  parser = new Parser({
    onopentag(name, attributes) {
      if (
        name === "head" &&
        parser.startIndex === shellHeadStart &&
        headOpenEnd === null
      ) {
        headOpenEnd = parser.endIndex + 1
      }
      if (name === "meta" && attributes["name"]?.toLowerCase() === "viewport") {
        hasViewport = true
      }
    },
    onclosetag(name, isImplied) {
      if (
        name === "head" &&
        !isImplied &&
        parser.endIndex === shellHeadEnd &&
        headCloseStart === null
      ) {
        headCloseStart = parser.startIndex
      }
    },
  })
  parser.end(html)
  return { headOpenEnd, headCloseStart, hasViewport }
}
