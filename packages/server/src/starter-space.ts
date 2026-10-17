import type { RecordCollectionSchema, WidgetFile } from "@worktable/types"
import { markdownToBlocks } from "./markdown.ts"

export const STARTER_SPACE_ID = "welcome"

export const PROMPTS_TO_TRY_MARKDOWN = `# Prompts to Try

Paste one into your agent and replace the brackets. Asking it to look for
existing work first keeps your Spaces tidy.

## Start a project

> In Worktable, find existing work about **[goal]**. Reuse its Space or make one.
> Write a short brief with the outcome, constraints, and open questions, then
> tell me where it is.

## Organize notes

> Read **[notes]** and organize them into a doc in Worktable. Keep decisions,
> sources, and uncertainties. Remove repetition and list what still needs checking.

## Track work

> Turn **[list or checklist]** into Records in Worktable, with the fields we need
> to sort and update them. Then build a board for them.

## Draw a plan

> Make a drawing of **[layout or process]** in Worktable. Label the important
> parts and leave room for us to revise it.

## Ask for a review

> Review **[doc]** for **[accuracy or clarity]**. Comment on the passages that
> need attention, make the changes I agree to, then resolve what you addressed.

## Build a tool

> Use **[data]** to build an HTML doc in Worktable that helps me **[task]**.
> Show your assumptions and test the controls before calling it done.

## Write a welcome

> Read the Spaces in this Worktable and draft a Start Here doc for new teammates:
> what each Space is for and where to begin. Then pin it in its Space.

See [What agents can make](/what-agents-can-make) for the formats an agent can use.
`

export const REVIEWING_WITH_YOUR_AGENT_MARKDOWN = `# Reviewing with Your Agent

Your agent can comment on a doc the way a colleague would, and you can comment
back.

## Ask for a review

> Review **[doc]** in Worktable for **[accuracy or clarity]**. Comment on the
> passages that need attention. Don't change the text yet.

Its comments appear beside the text. Reply to any of them, or select text and
add your own.

## Have it make the changes

> Read the comments on **[doc]** in Worktable. Make the changes we agreed on and
> resolve those comments. Reply to the rest.

Each change is saved as a version, so you can compare it with what was there
before.
`

export const AGENTS_THAT_STAY_ON_MARKDOWN = `# Agents That Stay On

Most agents work while you have them open. An always-on agent, such as OpenClaw
or Hermes, runs on a server and picks up work from Threads.

## Ask it for work

Start a Thread with it in Threads and say what you need. It replies there, and
what it makes is saved in your Spaces like any other agent's work.

## When it needs you

If it needs a decision, it asks in the Thread. Your reply goes straight back to
it.

## Connect one

Open Settings, then Agents, and choose OpenClaw, Hermes or another always-on
agent. Run the command on the machine where it runs.
`

export const TRACKING_WORK_IN_RECORDS_MARKDOWN = `# Tracking Work in Records

Records are rows with fields, for work that changes one item at a time: tasks,
leads, bugs, decisions. Your agents add and update them, and you can edit them
too.

## Start a list

> Turn **[list or checklist]** into Records in Worktable, with the fields we
> need to sort and update them.

## Put a board on top

> Build a board for the **[collection]** Records in Worktable, grouped by
> status.

The board shows the Records as they change. Example: Launch Plan in this Space
was built this way.

## Keep them current

> Go through the **[collection]** Records in Worktable and update the status of
> anything that has moved.
`

const WHAT_AGENTS_CAN_MAKE_MARKDOWN = `# What Agents Can Make

Ask an agent for the result you want. It chooses the format, and you review
the work here.

| Ask for | You get |
| --- | --- |
| A brief, plan, decision, or research summary | Doc |
| A layout, flow, or diagram | Drawing |
| A list of things that change one by one | Records |
| A calculator, dashboard, or custom view | HTML doc |
| Feedback on a passage | Comment |
| A conversation that keeps going | Thread |

## Combine them

### Plan a project

Ask for a brief with the goals and open questions. Then ask for the deliverables
as Records with a board. The Launch Plan example in this Space shows the result.

### Review together

Select a passage and ask an agent what it thinks. Its comments appear beside the
text, and it can make the changes you agree on.

### Keep an agent on call

Connect OpenClaw or Hermes in **Settings → Agents**, and it answers you in
Threads while you're away.

## Next

Try one of the [prompts](/prompts-to-try), or read the
[guides](https://docs.worktable.dev/) and [agent setup](https://docs.worktable.dev/agents/connections/).
`

const FORMAT_MERMAID = `flowchart LR
  A["What do you want?"] --> B{"What does it need?"}
  B --> C["Context and decisions<br/>Doc"]
  B --> H["Visual plans<br/>Drawing"]
  B --> D["Changing items<br/>Records"]
  B --> E["A focused interface<br/>HTML doc"]
  B --> F["Feedback in place<br/>Comment"]
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

export async function buildWhatAgentsCanMakeBlocks(): Promise<unknown[]> {
  const blocks = await markdownToBlocks(WHAT_AGENTS_CAN_MAKE_MARKDOWN)
  const combinationsIndex = blocks.findIndex(
    (block) =>
      block["type"] === "heading" && blockText(block) === "Combine them"
  )
  if (combinationsIndex < 0) {
    throw new Error(
      "Starter What Agents Can Make doc is missing its combinations section"
    )
  }

  blocks.splice(
    combinationsIndex,
    0,
    {
      id: "format-map-heading",
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
          text: "Choose a format",
          styles: {},
        },
      ],
      children: [],
    },
    {
      id: "format-map",
      type: "mermaid",
      props: {
        data: FORMAT_MERMAID,
        title: "Choose a format",
        collapsed: "false",
        locked: "false",
      },
      children: [],
    }
  )
  return blocks
}

export const LAUNCH_PLAN_COLLECTION_ID = "launch-plan"

export const STARTER_RECORD_FIELDS: RecordCollectionSchema["fields"] = {
  title: { type: "string", name: "Task", required: true },
  status: {
    type: "select",
    name: "Status",
    required: true,
    values: ["To do", "In progress", "Done"],
  },
  owner: { type: "string", name: "Owner" },
  detail: { type: "text", name: "Notes" },
  sequence: { type: "number", name: "Order", required: true },
}

export const STARTER_RECORDS = [
  {
    id: "launch-brief",
    data: {
      title: "Write the launch brief",
      status: "Done",
      owner: "Maya",
      detail: "Goals, audience, and the one thing people should remember.",
      sequence: 1,
    },
  },
  {
    id: "announcement",
    data: {
      title: "Draft the announcement",
      status: "In progress",
      owner: "Jon",
      detail: "A short post and an email, reviewed in comments.",
      sequence: 2,
    },
  },
  {
    id: "pricing-page",
    data: {
      title: "Update the pricing page",
      status: "In progress",
      owner: "Maya",
      detail: "New plan names and the comparison table.",
      sequence: 3,
    },
  },
  {
    id: "demo",
    data: {
      title: "Prepare the demo",
      status: "To do",
      owner: "Jon",
      detail: "A five-minute walkthrough of the main flow.",
      sequence: 4,
    },
  },
  {
    id: "launch-day",
    data: {
      title: "Plan launch day",
      status: "To do",
      owner: "Maya",
      detail: "Who posts what, and when.",
      sequence: 5,
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

export const LAUNCH_BOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>Launch Plan</title>
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
.board{min-width:780px;display:grid;grid-template-columns:repeat(3,minmax(235px,1fr));gap:24px}
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
  .board{min-width:760px}
  .agent-note{margin-top:24px}
}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style>
</head>
<body>
<main class="shell">
  <header class="header">
    <h1>Launch Plan</h1>
    <p>An example board over Records, the kind an agent can build for you. Drag a card to change its status.</p>
  </header>
  <div class="board-viewport" id="viewport">
    <section class="board" id="board" aria-label="Launch tasks grouped by status">
      <div class="loading">Loading records…</div>
    </section>
  </div>
  <footer class="agent-note">
    <p><span>Try it with your own work.</span> Ask an agent to turn a checklist into Records with a board.</p>
  </footer>
</main>
<div class="toast" id="toast" role="status" aria-live="polite"></div>
<script>
(function(){
  var statuses=["To do","In progress","Done"];
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
      await worktable.records.update("launch-plan",recordId,{status:status});
      state.records=state.records.map(function(item){return idOf(item)===recordId?Object.assign({},item,{data:Object.assign({},dataOf(item),{status:status})}):item});
      say("Status updated");
    }catch(error){
      say("Could not update status");
      if(worktable.ui&&worktable.ui.notify)worktable.ui.notify("Could not update the launch plan",{type:"error"});
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
    card.append(el("p","",[data.owner,data.detail].filter(Boolean).join(" · ")));
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
      var records=await worktable.records.query("launch-plan",recordsQuery);
      state.records=Array.isArray(records)?records:[];render();
      worktable.records.subscribe("launch-plan",recordsQuery,function(nextRecords){state.records=Array.isArray(nextRecords)?nextRecords:[];render()});
    }catch(error){board.innerHTML='<div class="loading">Could not load records.</div>'}
  }
  loadBoard();
})();
</script>
</body>
</html>`

export const STARTER_WIDGETS: readonly StarterWidgetDefinition[] = [
  {
    id: "launch-board",
    name: "Example: Launch Plan",
    description: "A board an agent built over the Launch Plan Records.",
    html: LAUNCH_BOARD_HTML,
    metadata: {
      purpose: "record-backed-project-board",
    },
    permissions: {
      network: false,
      records: {
        [LAUNCH_PLAN_COLLECTION_ID]: { read: true, update: true },
      },
      state: { read: false, write: false },
    },
  },
]
