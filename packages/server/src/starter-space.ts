import type { RecordCollectionSchema, WidgetFile } from "@worktable/types"
import { markdownToBlocks } from "./markdown.ts"

export const STARTER_SPACE_ID = "welcome"

export const EXAMPLE_PROMPTS_MARKDOWN = `# Example Prompts

Use these as starting points. Replace the details with your own work and keep only the structure you need.

## Start a useful space

> Create a space for us to work on **[goal]**. Start with one short Doc that explains the outcome, constraints, and open questions. Flesh out our existing thinking into a structure that makes sense for me to come back to.

## Turn rough notes into durable context

> Read **[document or notes]**. Organize the important reasoning into a clear Doc. Preserve decisions, uncertainties, and why they matter. Leave out repetition.

## Create structured work

> Create a Records collection for **[items]** in my Worktable. Use only the fields needed to sort, review, or update them independently. Help me organize them based on our conversation and your intuition.

## Review something in place

> Review **[Doc or HTML doc]** for **[clarity / accuracy / design / completeness]**. Leave Annotations on the exact places that need attention. Resolve only the items you actually address.

## Create an interactive doc

> Save this plan in an easy to read html presentation in my worktable. Focus on the most important things to call out, avoid any text or info that doesn't earn it's place, and make sure I can scan through it to get the context quickly.

## Give an agent four things

The strongest prompts usually name:

1. **Outcome:** what should be true when the work is finished.
2. **Source:** where the agent should read or write.
3. **Form:** Doc, Records, HTML doc, Annotation, or Thread.
4. **Boundary:** what should stay out of scope.

See [Ways to Work](/ways-to-work) when you are unsure which form fits.
`

const WAYS_TO_WORK_MARKDOWN = `# Ways to Work

Worktable is most useful when the shape of the work matches what you need to do. You do not need every feature for every project.

## Find what works

| When you want to…                                     | Use               | Because…                                                               |
| ----------------------------------------------------- | ----------------- | ---------------------------------------------------------------------- |
| Develop an idea, brief, decision, or body of research | **Doc, HTML doc** | The meaning lives in the whole piece of context.                       |
| Track structured items that change independently      | **Records**       | Each item can be updated, sorted, filtered, and reused.                |
| Turn information into a focused tool or visual view   | **HTML doc**      | The work benefits from an interface designed for the task.             |
| Leave feedback on a specific artifact                 | **Annotation**    | The conversation stays attached to what it is about.                   |
| Continue a broader conversation over time             | **Thread**        | The exchange can pause and resume without becoming the final artifact. |

## Useful combinations

### Plan and run a launch

Keep the brief and decisions in a Doc. Maintain a HTML map of the high level details. Track deliverables as Records. Ask an agent to turn those Records into a board or review view.

### Research a decision

Use a Doc for the argument, Records for sources or options, and Annotations for questions that need resolution.

### Run a recurring workflow

Keep the repeatable items in Records. Ask an agent to build an HTML doc that makes the common actions faster and easier to understand.

## A simple way to begin

1. Start with one Doc that explains what you are trying to accomplish.
2. Turn repeated or independently changing items into Records.
3. Ask an agent for a custom view only when it improves the work.
4. Leave feedback as Annotations so the context stays intact.

Next: open [Example Prompts](/example-prompts) and adapt one to something you actually want to make.
`

const WAYS_TO_WORK_MERMAID = `flowchart LR
  A["What do you want?"] --> B{"What does it need?"}
  B --> C["Context and decisions<br/>Doc"]
  B --> D["Changing items<br/>Records"]
  B --> E["A focused interface<br/>HTML doc"]
  B --> F["Feedback in place<br/>Annotation"]
  B --> G["An ongoing conversation<br/>Thread"]`

function blockText(block: Record<string, unknown>): string {
  const content = block["content"]
  if (!Array.isArray(content)) return ""
  return content
    .map((item) =>
      item && typeof item === "object" && "text" in item
        ? String((item as { text?: unknown }).text ?? "")
        : ""
    )
    .join("")
}

export async function buildWaysToWorkBlocks(): Promise<unknown[]> {
  const blocks = await markdownToBlocks(WAYS_TO_WORK_MARKDOWN)
  const combinationsIndex = blocks.findIndex(
    (block) =>
      block["type"] === "heading" && blockText(block) === "Useful combinations"
  )
  if (combinationsIndex < 0) {
    throw new Error(
      "Starter Ways to Work document is missing its combinations section"
    )
  }

  blocks.splice(
    combinationsIndex,
    0,
    {
      id: "ways-work-map-heading",
      type: "heading",
      props: {
        backgroundColor: "default",
        textColor: "default",
        textAlignment: "left",
        level: 2,
        isToggleable: false,
      },
      content: [
        {
          type: "text",
          text: "How the pieces fit together",
          styles: {},
        },
      ],
      children: [],
    },
    {
      id: "ways-work-map",
      type: "mermaid",
      props: {
        data: WAYS_TO_WORK_MERMAID,
        title: "Choose the form that fits the work",
        collapsed: "false",
        locked: "false",
      },
      children: [],
    }
  )
  return blocks
}

export const STARTER_RECORD_FIELDS: RecordCollectionSchema["fields"] = {
  title: { type: "string", name: "Guide item", required: true },
  status: {
    type: "select",
    name: "Status",
    required: true,
    values: ["Ready", "In progress", "Next", "Learned"],
  },
  outcome: { type: "text", name: "User outcome", required: true },
  sequence: { type: "number", name: "Order", required: true },
}

export const STARTER_RECORDS = [
  {
    id: "purpose-in-one-minute",
    data: {
      outcome:
        "A new user can tell when Docs, Records, HTML docs, Annotations, and Threads fit.",
      sequence: 1,
      status: "Next",
      title: "Explain the building blocks",
    },
  },
  {
    id: "real-project-context",
    data: {
      outcome:
        "The starter space demonstrates work a user can adapt, not placeholder content.",
      sequence: 2,
      status: "Ready",
      title: "Show useful examples",
    },
  },
  {
    id: "connected-record-view",
    data: {
      outcome:
        "The board and Records table stay connected to the same source of truth.",
      sequence: 3,
      status: "Next",
      title: "Connect Records to a custom view",
    },
  },
  {
    id: "first-useful-action",
    data: {
      outcome:
        "A new user can begin useful work with an agent from a concrete scenario.",
      sequence: 4,
      status: "Next",
      title: "Offer prompts worth trying",
    },
  },
  {
    id: "learn-from-review",
    data: {
      outcome:
        "Annotations turn review into visible changes to the starter experience.",
      sequence: 5,
      status: "Learned",
      title: "Improve the guide through feedback",
    },
  },
] as const

export interface StarterWidgetDefinition {
  id: string
  name: string
  description: string
  html: string
  metadata: Record<string, unknown>
  permissions: WidgetFile["permissions"]
}

export const START_HERE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Welcome to your Worktable</title>
<style>
:root{
  color-scheme:light dark;
  --ad-bg:#f6f6f5;
  --ad-surface:#ffffff;
  --ad-surface-2:#eeeeed;
  --ad-text:#1b1b1d;
  --ad-muted:#717178;
  --ad-border:#d7d7da;
  --ad-accent:#1769aa;
  --ad-accent-soft:#e8f1f8;
  --ad-danger:#b84c3a;
  --ad-warning:#9a6827;
  --ad-success:#3d735b;
  --ad-radius:12px;
  --ad-shadow:none;
  --display:"Fraunces","Iowan Old Style","Palatino Linotype",Georgia,serif;
  --sans:"General Sans","Avenir Next",Avenir,"Segoe UI",sans-serif;
}
html[data-theme="dark"]{
  --ad-bg:#111113;
  --ad-surface:#19191c;
  --ad-surface-2:#242428;
  --ad-text:#f0f0f1;
  --ad-muted:#9c9ca5;
  --ad-border:#34343a;
  --ad-accent:#69aee6;
  --ad-accent-soft:#172536;
  --ad-danger:#ed8b78;
  --ad-warning:#d7aa6a;
  --ad-success:#83bea1;
}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--ad-bg)}
body{color:var(--ad-text);font-family:var(--sans);font-size:16px;font-weight:440;letter-spacing:.01em;line-height:1.55}
.page{width:min(1060px,calc(100% - 48px));margin:0 auto;padding:clamp(72px,11vh,120px) 0 70px}
.opening{max-width:840px;margin-bottom:clamp(72px,10vh,112px)}
h1{margin:0;font-family:var(--display);font-size:clamp(56px,7.4vw,86px);font-weight:400;letter-spacing:-.025em;line-height:.98}
.opening p{max-width:690px;margin:28px 0 0;color:var(--ad-muted);font-size:clamp(18px,2vw,21px);font-weight:420;line-height:1.6}
.journey{margin:0;padding:0;list-style:none;border-top:1px solid var(--ad-border)}
.step{display:grid;grid-template-columns:72px minmax(0,1fr) 238px;gap:26px;align-items:center;min-height:174px;padding:30px 0;border-bottom:1px solid var(--ad-border)}
.number{align-self:start;padding-top:7px;color:var(--ad-accent);font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12px;font-weight:500}
.step h2{margin:0;font-size:clamp(24px,3vw,34px);font-weight:480;letter-spacing:-.014em;line-height:1.18}
.step p{max-width:590px;margin:11px 0 0;color:var(--ad-muted);font-size:15px;font-weight:420}
.where{justify-self:end;width:100%;padding-left:28px;color:var(--ad-muted);font-size:13px}
.where span{display:block;margin-bottom:4px;color:var(--ad-text);font-size:14px;font-weight:480}
@media(max-width:700px){
  .page{width:calc(100% - 30px);padding:68px 0 48px}
  .opening{margin-bottom:68px}
  h1{font-size:clamp(52px,15vw,70px)}
  .opening p{font-size:17px}
  .step{grid-template-columns:40px 1fr;gap:14px;min-height:0;padding:34px 0}
  .number{padding-top:5px}
  .where{grid-column:2;justify-self:start;width:auto;margin-top:15px;padding-left:0}
}
</style>
</head>
<body>
<main class="page">
  <section class="opening">
    <h1>Welcome to your Worktable</h1>
    <p>Explore this space for a quick look at what you and your agents can create.</p>
  </section>
  <ol class="journey">
    <li class="step">
      <span class="number">01</span>
      <div>
        <h2>Work gets stored in different shapes.</h2>
        <p>See when a Doc, Record, HTML doc, Annotation, or Thread fits.</p>
      </div>
      <div class="where"><span>Ways to Work</span>Documents</div>
    </li>
    <li class="step">
      <span class="number">02</span>
      <div>
        <h2>Start with a useful prompt.</h2>
        <p>View example scenarios, then adapt to your own work.</p>
      </div>
      <div class="where"><span>Example Prompts</span>Documents</div>
    </li>
    <li class="step">
      <span class="number">03</span>
      <div>
        <h2>See a custom view in action.</h2>
        <p>This board is built from the same Records you can open in the table.</p>
      </div>
      <div class="where"><span>Onboarding Board</span>HTML docs</div>
    </li>
  </ol>
</main>
</body>
</html>`

export const ONBOARDING_BOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Onboarding Board</title>
<style>
:root{
  color-scheme:light dark;
  --ad-bg:#f6f6f5;
  --ad-surface:#ffffff;
  --ad-surface-2:#eeeeed;
  --ad-text:#1b1b1d;
  --ad-muted:#717178;
  --ad-border:#d7d7da;
  --ad-accent:#1769aa;
  --ad-accent-soft:#e8f1f8;
  --ad-danger:#b84c3a;
  --ad-warning:#9a6827;
  --ad-success:#3d735b;
  --ad-radius:12px;
  --ad-shadow:none;
  --display:"Fraunces","Iowan Old Style","Palatino Linotype",Georgia,serif;
  --sans:"General Sans","Avenir Next",Avenir,"Segoe UI",sans-serif;
}
html[data-theme="dark"]{
  --ad-bg:#111113;
  --ad-surface:#19191c;
  --ad-surface-2:#242428;
  --ad-text:#f0f0f1;
  --ad-muted:#9c9ca5;
  --ad-border:#34343a;
  --ad-accent:#69aee6;
  --ad-accent-soft:#172536;
  --ad-danger:#ed8b78;
  --ad-warning:#d7aa6a;
  --ad-success:#83bea1;
}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%;background:var(--ad-bg)}
body{color:var(--ad-text);font-family:var(--sans);font-size:15px;font-weight:440;letter-spacing:.01em;line-height:1.5}
select{font:inherit}
select:focus-visible{outline:3px solid color-mix(in srgb,var(--ad-accent) 48%,transparent);outline-offset:2px}
.shell{width:min(1320px,calc(100% - 48px));margin:0 auto;padding:52px 0 42px}
.header{margin-bottom:40px}
h1{margin:0;font-family:var(--display);font-size:clamp(48px,5.8vw,72px);font-weight:400;letter-spacing:-.025em;line-height:1}
.header p{max-width:540px;margin:15px 0 0;color:var(--ad-muted);font-size:15px;font-weight:420}
.board-viewport{overflow-x:auto;padding-bottom:16px;scrollbar-width:thin;scrollbar-color:var(--ad-border) transparent}
.board-viewport[data-fade="right"]{-webkit-mask-image:linear-gradient(to right,#000 0,#000 calc(100% - 34px),transparent 100%);mask-image:linear-gradient(to right,#000 0,#000 calc(100% - 34px),transparent 100%)}
.board-viewport[data-fade="left"]{-webkit-mask-image:linear-gradient(to right,transparent 0,#000 34px,#000 100%);mask-image:linear-gradient(to right,transparent 0,#000 34px,#000 100%)}
.board-viewport[data-fade="both"]{-webkit-mask-image:linear-gradient(to right,transparent 0,#000 34px,#000 calc(100% - 34px),transparent 100%);mask-image:linear-gradient(to right,transparent 0,#000 34px,#000 calc(100% - 34px),transparent 100%)}
.board{min-width:1060px;display:grid;grid-template-columns:repeat(4,minmax(235px,1fr));gap:24px}
.column{min-width:0;padding:0 1px}
.column-head{display:flex;align-items:center;justify-content:space-between;padding:0 12px 13px;border-bottom:1px solid var(--ad-border)}
.column h2{margin:0;font-size:14px;font-weight:500}
.count{color:var(--ad-muted);font-size:12px}
.stack{display:flex;flex-direction:column;gap:10px;min-height:208px;margin:10px 0 0;padding:12px 12px 18px;border:1px solid transparent;border-radius:var(--ad-radius)}
.column.dragover .stack{background:var(--ad-accent-soft);border-color:color-mix(in srgb,var(--ad-accent) 35%,var(--ad-border))}
.card{position:relative;padding:17px 16px 15px;background:var(--ad-surface);border:1px solid var(--ad-border);border-radius:var(--ad-radius);cursor:auto;user-select:text;transition:opacity .15s ease,border-color .15s ease,transform .15s ease}
.card:hover{border-color:color-mix(in srgb,var(--ad-border) 48%,var(--ad-text))}
.card.dragging{opacity:.42;transform:scale(.985)}
.card.saving{opacity:.58}
.card-top{display:flex;align-items:start;justify-content:space-between;gap:12px}
.card h3{margin:0;font-size:16px;font-weight:500;letter-spacing:-.006em;line-height:1.3}
.grip{flex:none;width:28px;height:28px;margin:-5px -6px 0 0;display:grid;place-items:center;border-radius:7px;color:var(--ad-muted);cursor:grab;user-select:none;touch-action:none}
.grip:hover{background:var(--ad-surface-2);color:var(--ad-text)}
.grip:active{cursor:grabbing}
.grip svg{width:14px;height:14px;pointer-events:none}
.card p{margin:10px 0 17px;color:var(--ad-muted);font-size:13px;font-weight:420;line-height:1.5}
.select-wrap{position:relative}
.select-wrap::after{content:"";position:absolute;right:14px;top:50%;width:7px;height:7px;border-right:1.5px solid var(--ad-muted);border-bottom:1.5px solid var(--ad-muted);transform:translateY(-68%) rotate(45deg);pointer-events:none}
select{appearance:none;-webkit-appearance:none;width:100%;height:42px;padding:9px 40px 9px 13px;border:1px solid var(--ad-border);border-radius:9px;background:var(--ad-surface-2);color:var(--ad-text);font-size:13px;font-weight:440;cursor:pointer}
select:hover{border-color:color-mix(in srgb,var(--ad-border) 45%,var(--ad-text))}
.empty{display:grid;place-items:center;min-height:132px;color:var(--ad-muted);font-size:13px}
.loading{grid-column:1/-1;padding:100px 0;color:var(--ad-muted);text-align:center}
.agent-note{margin-top:30px;padding-top:20px;border-top:1px solid var(--ad-border);color:var(--ad-muted);font-size:13px;font-weight:420}
.agent-note p{margin:0}
.agent-note span{color:var(--ad-text);font-weight:480}
.toast{position:fixed;right:18px;bottom:18px;padding:10px 13px;border:1px solid var(--ad-border);border-radius:10px;background:var(--ad-surface);color:var(--ad-text);font-size:13px;opacity:0;transform:translateY(7px);pointer-events:none;transition:.16s ease}
.toast.show{opacity:1;transform:none}
@media(max-width:760px){
  .shell{width:calc(100% - 30px);padding:34px 0 28px}
  .header{margin-bottom:30px}
  h1{font-size:53px}
  .header p{margin-top:13px}
  .board{min-width:1000px}
  .agent-note{margin-top:24px}
}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>
<main class="shell">
  <header class="header">
    <h1>Onboarding Board</h1>
    <p>Drag a handle to update status. Records stay in sync.</p>
  </header>
  <div class="board-viewport" id="viewport">
    <section class="board" id="board" aria-label="Onboarding work grouped by status">
      <div class="loading">Loading records…</div>
    </section>
  </div>
  <footer class="agent-note">
    <p><span>This board was made by an agent.</span> Ask yours to shape a view around your Records.</p>
  </footer>
</main>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script>
(function(){
  var statuses=["Ready","In progress","Next","Learned"];
  var state={records:[],saving:new Set(),dragging:null};
  var board=document.getElementById("board");
  var viewport=document.getElementById("viewport");
  var toast=document.getElementById("toast");
  function dataOf(record){return record&&record.data?record.data:record||{}}
  function idOf(record){return String(record&&record.id||"")}
  function el(tag,className,text){var node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node}
  function say(message){toast.textContent=message;toast.classList.add("show");clearTimeout(say.timer);say.timer=setTimeout(function(){toast.classList.remove("show")},1500)}
  function updateFade(){
    var overflow=viewport.scrollWidth>viewport.clientWidth+2;
    if(!overflow){viewport.removeAttribute("data-fade");return}
    var left=viewport.scrollLeft>2;
    var right=viewport.scrollLeft+viewport.clientWidth<viewport.scrollWidth-2;
    viewport.dataset.fade=left&&right?"both":left?"left":"right";
  }
  async function move(recordId,status){
    var record=state.records.find(function(item){return idOf(item)===recordId});
    if(!record||dataOf(record).status===status||state.saving.has(recordId))return;
    state.saving.add(recordId);render();
    try{
      await worktable.records.update("onboarding-work",recordId,{status:status});
      state.records=state.records.map(function(item){return idOf(item)===recordId?Object.assign({},item,{data:Object.assign({},dataOf(item),{status:status})}):item});
      say("Status updated");
    }catch(error){
      say("Could not update status");
      if(worktable.ui&&worktable.ui.notify)worktable.ui.notify("Could not update onboarding work",{type:"error"});
    }finally{
      state.saving.delete(recordId);state.dragging=null;render();
    }
  }
  function renderCard(record){
    var data=dataOf(record),id=idOf(record);
    var card=el("article","card"+(state.saving.has(id)?" saving":""));
    card.dataset.id=id;
    var top=el("div","card-top");
    top.append(el("h3","",data.title||"Untitled"));
    var grip=el("span","grip");
    grip.draggable=true;
    grip.title="Drag to move";
    grip.setAttribute("aria-label","Drag "+data.title);
    grip.innerHTML='<svg viewBox="0 0 16 16" fill="currentColor"><circle cx="5" cy="4" r="1.2"/><circle cx="11" cy="4" r="1.2"/><circle cx="5" cy="8" r="1.2"/><circle cx="11" cy="8" r="1.2"/><circle cx="5" cy="12" r="1.2"/><circle cx="11" cy="12" r="1.2"/></svg>';
    grip.addEventListener("dragstart",function(event){
      var rect=card.getBoundingClientRect();
      var offsetX=Math.max(0,Math.min(rect.width,event.clientX-rect.left));
      var offsetY=Math.max(0,Math.min(rect.height,event.clientY-rect.top));
      if(event.dataTransfer.setDragImage)event.dataTransfer.setDragImage(card,offsetX,offsetY);
      state.dragging=id;
      event.dataTransfer.effectAllowed="move";event.dataTransfer.setData("text/plain",id);
      requestAnimationFrame(function(){card.classList.add("dragging")});
    });
    grip.addEventListener("dragend",function(){
      state.dragging=null;card.classList.remove("dragging");
      document.querySelectorAll(".column").forEach(function(column){column.classList.remove("dragover")});
    });
    top.append(grip);card.append(top);
    card.append(el("p","",data.outcome||""));
    var wrap=el("div","select-wrap");
    var select=el("select","");
    select.setAttribute("aria-label","Status for "+data.title);
    statuses.forEach(function(status){var option=el("option","",status);option.value=status;option.selected=status===data.status;select.append(option)});
    select.disabled=state.saving.has(id);
    select.addEventListener("change",function(){move(id,select.value)});
    wrap.append(select);card.append(wrap);return card;
  }
  function render(){
    board.replaceChildren();
    statuses.forEach(function(status){
      var column=el("section","column");
      column.dataset.status=status;
      var matches=state.records.filter(function(record){return dataOf(record).status===status}).sort(function(a,b){return Number(dataOf(a).sequence)-Number(dataOf(b).sequence)});
      var head=el("div","column-head");
      head.append(el("h2","",status));head.append(el("span","count",String(matches.length)));column.append(head);
      var stack=el("div","stack");
      if(matches.length)matches.forEach(function(record){stack.append(renderCard(record))});
      else stack.append(el("div","empty","Drop here"));
      column.append(stack);
      column.addEventListener("dragover",function(event){event.preventDefault();column.classList.add("dragover");event.dataTransfer.dropEffect="move"});
      column.addEventListener("dragleave",function(event){if(!column.contains(event.relatedTarget))column.classList.remove("dragover")});
      column.addEventListener("drop",function(event){
        event.preventDefault();column.classList.remove("dragover");
        var id=event.dataTransfer.getData("text/plain")||state.dragging;move(id,status);
      });
      board.append(column);
    });
    requestAnimationFrame(updateFade);
  }
  viewport.addEventListener("scroll",updateFade,{passive:true});
  window.addEventListener("resize",updateFade);
  var recordsQuery={orderBy:"sequence",order:"asc",limit:20};
  async function loadBoard(){
    try{
      var records=await worktable.records.query("onboarding-work",recordsQuery);
      state.records=Array.isArray(records)?records:[];render();
      worktable.records.subscribe("onboarding-work",recordsQuery,function(nextRecords){state.records=Array.isArray(nextRecords)?nextRecords:[];render()});
    }catch(error){board.innerHTML='<div class="loading">Could not load records.</div>'}
  }
  loadBoard();
})();
</script>
</body>
</html>`

export const STARTER_WIDGETS: readonly StarterWidgetDefinition[] = [
  {
    id: "onboarding-board",
    name: "Onboarding Board",
    description: "A draggable Kanban view over the five Welcome Guide records.",
    html: ONBOARDING_BOARD_HTML,
    metadata: {
      journeyOrder: 3,
      purpose: "record-backed-project-board",
    },
    permissions: {
      network: false,
      records: {
        "onboarding-work": { read: true, update: true },
      },
      state: { read: false, write: false },
    },
  },
  {
    id: "welcome",
    name: "Start Here",
    description:
      "A first-use guide to what people can create in Worktable and build with agents.",
    html: START_HERE_HTML,
    metadata: {
      journeyOrder: 1,
      purpose: "guided-welcome",
    },
    permissions: {
      network: false,
      records: {},
      state: { read: false, write: false },
    },
  },
]
