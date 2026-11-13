import {
  HTML_ELEMENT_ATTRIBUTES,
  HTML_ELEMENT_CONTEXT_LENGTH,
  HTML_ELEMENT_QUOTE_LENGTH,
  matchHtmlElement,
} from "@worktable/types"
import { HTML_DOC_THEME } from "@worktable/ui/lib/html-doc-theme.generated"
import { themeConfig } from "@worktable/ui/theme"

const COLORS = JSON.stringify({
  light: {
    pick: HTML_DOC_THEME.light.primary,
    mark: themeConfig.accents.bronze.light,
    edge: HTML_DOC_THEME.light.background,
  },
  dark: {
    pick: HTML_DOC_THEME.dark.primary,
    mark: themeConfig.accents.bronze.dark,
    edge: HTML_DOC_THEME.dark.background,
  },
})

/**
 * Comments on elements of an HTML Doc's page, for the runtime's closure: it
 * uses the runtime's `cfg`, `postToParent` and `navigationToken`.
 *
 * The app owns the mode and the comments. This part outlines what the
 * pointer is over, describes the element that is chosen, and marks the
 * elements open comments are about, finding each again as the page changes.
 * It does nothing, and listens only for the app and the shortcut, until the
 * app turns the mode on or sends comments to mark. It is never shown a
 * comment's words or who wrote it.
 */
export const WIDGET_COMMENT_RUNTIME = String.raw`
(function(){
const matchElement=${matchHtmlElement.toString()};
const QUOTE=${HTML_ELEMENT_QUOTE_LENGTH};
const CONTEXT=${HTML_ELEMENT_CONTEXT_LENGTH};
const ATTRIBUTES=${HTML_ELEMENT_ATTRIBUTES};
const COLORS=${COLORS};
const NAMING=/^(data-(?!worktable)[\w-]+|role|aria-label|name|href|src|alt|title|type|placeholder|for)$/;
const BLOCKED=['pointerdown','mousedown','pointerup','mouseup','dblclick','auxclick','contextmenu','dragstart','submit'];
function send(type,payload){try{postToParent(Object.assign({type:'worktable.comment.'+type,widgetId:cfg.widgetId,spaceId:cfg.spaceId,navigationToken:navigationToken},payload),'*')}catch{}}
let host=null,cursor=null,hoverBox=null,markBox=null,pinLayer=null;
let mode=false,hovered=null,picked=null,pinHover=null,pins=[],activeId=null;
let frame=0,settle=0,searched=0,watching=false,observer=null,resizes=null,reported='',lastRect='';
const buttons=new Map();

// The same reading of the page as html-element-locate.ts has of its source:
// the text is every piece of text in order, each trimmed and with its spaces
// collapsed, joined by single spaces; scripts and styles are not text.
function piece(node){
  const parent=node.parentElement;
  if(parent&&parent.closest('script,style,noscript'))return '';
  return node.nodeValue.replace(/\s+/g,' ').trim();
}
function textOf(el,length){
  let text='';
  const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);
  for(let node=walker.nextNode();node&&text.length<length;node=walker.nextNode()){
    const next=piece(node);
    if(next)text+=text?' '+next:next;
  }
  return text.slice(0,length);
}
// The page's text just before an element, and just after it.
function beside(el){
  const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
  let before='',after='';
  walker.currentNode=el;
  for(let node=walker.previousNode();node&&before.length<CONTEXT;node=walker.previousNode()){
    const next=piece(node);
    if(next)before=before?next+' '+before:next;
  }
  let last=el;
  while(last.lastChild)last=last.lastChild;
  walker.currentNode=last;
  for(let node=walker.nextNode();node&&after.length<CONTEXT;node=walker.nextNode()){
    const next=piece(node);
    if(next)after+=after?' '+next:next;
  }
  return [before.slice(-CONTEXT),after.slice(0,CONTEXT)];
}
function segment(el){
  let same=0,at=0;
  if(el.parentElement)for(const child of el.parentElement.children){if(child.localName===el.localName){same++;if(child===el)at=same}}
  return el.localName+(el.id&&el.id.length<=40?'#'+el.id:'')+(same>1?':nth-of-type('+at+')':'');
}
function headingsNow(){return Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6'))}
function headingBefore(el,headings){
  let low=0,high=headings.length;
  while(low<high){
    const mid=(low+high)>>1,heading=headings[mid];
    if(heading!==el&&!heading.contains(el)&&(heading.compareDocumentPosition(el)&Node.DOCUMENT_POSITION_FOLLOWING))low=mid+1;else high=mid;
  }
  return low?textOf(headings[low-1],120):'';
}
function describe(el,headings){
  const text=textOf(el,QUOTE),path=[],around=document.body.contains(el)?beside(el):['',''];
  for(let node=el;node&&node!==document.body&&node!==document.documentElement;node=node.parentElement)path.unshift(segment(node));
  const attrs={};let count=0;
  for(const attr of el.attributes){
    if(count>=ATTRIBUTES)break;
    if(attr.name.length<=40&&NAMING.test(attr.name)&&attr.value.indexOf('data:')!==0){attrs[attr.name]=attr.value.slice(0,160);count++}
  }
  const out={tag:el.localName,classes:(el.getAttribute('class')||'').split(/\s+/).filter(function(name){return name&&name.length<=80}).slice(0,6),attrs:attrs,path:path.slice(-12).join(' > ').slice(-600)};
  if(el.id&&el.id.length<=200)out.id=el.id;
  if(text)out.text=text;
  if(around[0])out.before=around[0];
  if(around[1])out.after=around[1];
  const heading=headingBefore(el,headings);
  if(heading)out.heading=heading;
  return out;
}
function rectOf(el){const r=el.getBoundingClientRect();return {x:r.left,y:r.top,width:r.width,height:r.height}}

// What a press chooses: the control or graphic as a whole, else the element itself.
function pickable(node){
  let el=node&&node.nodeType===1?node:node&&node.parentElement;
  if(!el||el===host||el===document.documentElement||el===document.body)return null;
  if(el.ownerSVGElement)el=el.ownerSVGElement;
  return el.closest('button,a[href],summary,label,select,[role="button"]')||el;
}

function ensure(){
  if(host&&host.isConnected)return;
  if(!host){
    const colors=COLORS[document.documentElement.getAttribute('data-theme')==='light'?'light':'dark'];
    host=document.createElement('worktable-comments');
    host.style.cssText='all:initial;position:absolute;top:0;left:0;width:0;height:0;z-index:2147483647;pointer-events:none';
    const shadow=host.attachShadow({mode:'closed'});
    shadow.innerHTML='<style>'
      +'div,button{position:absolute;top:0;left:0;box-sizing:border-box;margin:0;padding:0}'
      +'.box{display:none;border-radius:4px;pointer-events:none;outline-offset:1px}'
      +'.hover{outline:2px solid '+colors.pick+';background:color-mix(in oklch,'+colors.pick+' 8%,transparent)}'
      +'.mark{outline:2px solid '+colors.mark+';background:color-mix(in oklch,'+colors.mark+' 14%,transparent)}'
      +'button{width:18px;height:18px;margin:-9px 0 0 -9px;border:2px solid '+colors.edge+';border-radius:50%;cursor:pointer;pointer-events:auto;'
      +'background:radial-gradient(circle at 35% 30%,color-mix(in oklab,'+colors.mark+' 58%,white),'+colors.mark+' 55%,color-mix(in oklab,'+colors.mark+' 74%,black));'
      +'box-shadow:0 1px 3px rgb(0 0 0/.35);transition:scale .12s}'
      +'button:hover,button[aria-current]{scale:1.25}'
      +'button:focus-visible{outline:2px solid '+colors.pick+';outline-offset:2px}'
      +'@media print{:host{display:none}}'
      +'</style><div class="box hover"></div><div class="box mark"></div><div class="pins"></div>';
    hoverBox=shadow.querySelector('.hover');markBox=shadow.querySelector('.mark');pinLayer=shadow.querySelector('.pins');
    // In the page, not the shadow: the pointer over the page shows the mode.
    cursor=document.createElement('style');
    cursor.textContent='*{cursor:crosshair !important}';
    cursor.media='not all';
    host.appendChild(cursor);
  }
  document.documentElement.appendChild(host);
}
function place(box,el,origin){
  const r=el&&el.isConnected?el.getBoundingClientRect():null;
  if(!r||(!r.width&&!r.height)){box.style.display='none';return}
  box.style.display='block';
  box.style.translate=(r.left-origin.left)+'px '+(r.top-origin.top)+'px';
  box.style.width=r.width+'px';box.style.height=r.height+'px';
}
function paint(){
  frame=0;
  if(!mode&&!pins.length&&!picked){if(host)host.remove();return}
  ensure();
  const media=mode?'all':'not all';
  if(cursor.media!==media)cursor.media=media;
  const origin=host.getBoundingClientRect();
  const active=pins.find(function(pin){return pin.id===activeId});
  const marked=picked||pinHover||(active&&active.el)||null;
  place(hoverBox,mode&&hovered!==marked?hovered:null,origin);
  place(markBox,marked,origin);
  const seen=new Set(),stacked=new Map();
  for(const pin of pins){
    const r=pin.el&&pin.el.isConnected?pin.el.getBoundingClientRect():null;
    if(!r||(!r.width&&!r.height))continue;
    let button=buttons.get(pin.id);
    if(!button){
      button=document.createElement('button');
      button.type='button';
      button.setAttribute('aria-label','Comment');
      button.addEventListener('click',function(){send('open',{id:pin.id})});
      button.addEventListener('pointerenter',function(){const now=pins.find(function(other){return other.id===pin.id});pinHover=now&&now.el||null;draw()});
      button.addEventListener('pointerleave',function(){pinHover=null;draw()});
      buttons.set(pin.id,button);pinLayer.appendChild(button);
    }
    seen.add(pin.id);
    const before=stacked.get(pin.el)||0;stacked.set(pin.el,before+1);
    if(pin.id===activeId)button.setAttribute('aria-current','true');else button.removeAttribute('aria-current');
    const along=pin.anchor&&pin.anchor.element&&typeof pin.anchor.element.pin==='number'?pin.anchor.element.pin:1;
    button.style.translate=Math.max(11,r.left-origin.left+r.width*along+before*20)+'px '+Math.max(11,r.top-origin.top)+'px';
  }
  for(const entry of buttons){if(!seen.has(entry[0])){entry[1].remove();buttons.delete(entry[0])}}
  if(picked){
    if(!picked.isConnected){picked=null;send('rect',{rect:null});return}
    const rect=rectOf(picked),key=[rect.x,rect.y,rect.width,rect.height].join();
    if(key!==lastRect){lastRect=key;send('rect',{rect:rect})}
  }
}
function draw(){if(!frame)frame=requestAnimationFrame(paint)}

// Finds each comment's element again, and tells the app which are gone. An
// element still where it was is confirmed cheaply. Looking through the page
// for one that moved or changed costs more, so a page that keeps changing
// is searched at most every two seconds.
function locate(now){
  clearTimeout(settle);settle=0;
  const search=now===true||Date.now()-searched>=2000;
  const headings=pins.length?headingsNow():[],groups={},states={};
  let waiting=false;
  for(const pin of pins){
    const anchor=pin.anchor,element=anchor&&anchor.element;
    let hit=null;
    if(element&&typeof element.tag==='string'&&typeof element.path==='string'){
      const target=Object.assign({},element);
      if(typeof anchor.quote==='string')target.text=anchor.quote;
      const kept=pin.el&&pin.el.isConnected&&pin.el.localName===element.tag;
      if(kept){
        const still=matchElement(target,[describe(pin.el,headings)]);
        if(still&&still.match==='exact')hit={el:pin.el,match:'exact'};
      }
      if(!hit&&!search){
        waiting=true;
        if(kept&&pin.state==='changed')hit={el:pin.el,match:'fuzzy'};
      }else if(!hit){
        searched=Date.now();
        let group=groups[element.tag];
        if(!group){
          group=groups[element.tag]={els:[],described:[]};
          const all=document.getElementsByTagName(element.tag);
          for(let at=0;at<all.length&&group.els.length<3000;at++){if(all[at]!==host){group.els.push(all[at]);group.described.push(describe(all[at],headings))}}
        }
        const found=matchElement(target,group.described);
        if(found)hit={el:group.els[found.index],match:found.match};
      }
    }
    pin.el=hit?hit.el:null;
    pin.state=states[pin.id]=hit?(hit.match==='exact'?'found':'changed'):'gone';
  }
  const report=JSON.stringify(states);
  if(report!==reported){reported=report;send('status',{states:states})}
  if(waiting)settle=setTimeout(locate,2000,true);
  watch();draw();
}
function relocate(){if(!settle)settle=setTimeout(locate,250)}
function ours(records){
  for(const record of records){
    if(host&&host.contains(record.target))continue;
    if(record.type!=='childList')return false;
    for(const node of record.addedNodes)if(node!==host)return false;
    for(const node of record.removedNodes)if(node!==host)return false;
  }
  return true;
}
// Follows the page only while there is something to draw.
function watch(){
  const wanted=mode||pins.length>0||Boolean(picked);
  if(wanted===watching)return;
  watching=wanted;
  if(wanted){
    window.addEventListener('scroll',draw,true);
    window.addEventListener('resize',draw);
    // A class, a style or hidden moves or hides things without changing what
    // the page says: the marks are drawn again, and nothing is looked for.
    observer=new MutationObserver(function(records){
      if(ours(records))return;
      if(pins.length&&records.some(function(record){return record.type!=='attributes'}))relocate();
      draw();
    });
    observer.observe(document.documentElement,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class','style','hidden','open']});
    window.addEventListener('transitionend',draw,true);
    window.addEventListener('animationend',draw,true);
    if(typeof ResizeObserver==='function'){resizes=new ResizeObserver(draw);resizes.observe(document.documentElement);if(document.body)resizes.observe(document.body)}
  }else{
    window.removeEventListener('scroll',draw,true);
    window.removeEventListener('resize',draw);
    window.removeEventListener('transitionend',draw,true);
    window.removeEventListener('animationend',draw,true);
    if(observer)observer.disconnect();
    if(resizes)resizes.disconnect();
    observer=resizes=null;
  }
}

function block(event){
  if(event.target===host)return;
  event.preventDefault();event.stopImmediatePropagation();
}
function hover(event){
  if(event.pointerType&&event.pointerType!=='mouse')return;
  const el=event.target===host?null:pickable(event.target);
  if(el!==hovered){hovered=el;draw()}
}
function leave(event){if(!event.relatedTarget&&hovered){hovered=null;draw()}}
function choose(event){
  if(event.target===host)return;
  event.preventDefault();event.stopImmediatePropagation();
  const el=pickable(event.target);
  if(!el)return;
  const described=describe(el,headingsNow()),text=described.text;
  delete described.text;
  const opening=/^<[^>]*>/.exec(el.cloneNode(false).outerHTML);
  if(opening)described.html=opening[0].slice(0,300);
  const box=el.getBoundingClientRect();
  if(box.width&&typeof event.clientX==='number')described.pin=Math.round(Math.min(1,Math.max(0,(event.clientX-box.left)/box.width))*1000)/1000;
  picked=el;hovered=null;lastRect='';
  send('pick',{anchor:text?{quote:text,element:described}:{element:described},rect:rectOf(el),touch:event.pointerType==='touch'});
  watch();draw();
}
function setMode(on){
  if(on===mode)return;
  mode=on;hovered=null;
  const change=on?window.addEventListener:window.removeEventListener;
  for(const type of BLOCKED)change.call(window,type,block,true);
  change.call(window,'click',choose,true);
  change.call(window,'pointermove',hover,true);
  change.call(document,'mouseout',leave,true);
}
window.addEventListener('message',function(event){
  if(event.source!==window.parent)return;
  const data=event.data;
  if(!data||typeof data.type!=='string')return;
  if(data.type==='worktable.comment.set'){
    setMode(data.mode===true);
    if(!data.draft)picked=null;
    activeId=typeof data.activeId==='string'?data.activeId:null;
    const before=new Map(pins.map(function(pin){return [pin.id,pin]}));
    pins=(Array.isArray(data.pins)?data.pins:[]).slice(0,200).filter(function(pin){return pin&&typeof pin.id==='string'}).map(function(pin){const was=before.get(pin.id);return {id:pin.id,anchor:pin.anchor,el:was?was.el:null,state:was?was.state:''}});
    locate(true);
  }else if(data.type==='worktable.comment.reveal'){
    const pin=pins.find(function(other){return other.id===data.id});
    if(!pin||!pin.el||!pin.el.isConnected)return;
    const r=pin.el.getBoundingClientRect();
    if(r.bottom<0||r.top>window.innerHeight||r.right<0||r.left>window.innerWidth)
      pin.el.scrollIntoView({block:'center',inline:'nearest',behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
  }
});
window.addEventListener('keydown',function(event){
  if(mode&&event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();send('key',{key:'Escape'})}
  else if((event.metaKey||event.ctrlKey)&&event.altKey&&event.code==='KeyM'){event.preventDefault();send('key',{key:'toggle'})}
},true);
})();
`
