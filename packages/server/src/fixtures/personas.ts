/**
 * Worktable Labs — synthetic persona starter fixtures for different roles.
 * Keep names, organizations, and scenarios fictional.
 */
import type { FixtureDef } from "./defs.ts"
import { blockDoc } from "./blocks.ts"
import type { FixtureBuilder } from "./harness.ts"
import { fixtureThread } from "./threads.ts"

const INCIDENT_BOARD_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>Incident Board</title>
    <style>
      body { font: 14px system-ui, sans-serif; margin: 0; padding: 16px; }
      h1 { font-size: 16px; margin: 0 0 12px; }
      .row { display: flex; gap: 8px; padding: 6px 0; border-bottom: 1px solid #eee; }
      .sev { font-weight: 600; width: 56px; }
      .sev1 { color: #c0392b; } .sev2 { color: #d35400; } .sev3 { color: #7f8c8d; }
    </style>
  </head>
  <body>
    <h1>Open incidents</h1>
    <div id="list">Loading…</div>
    <script type="module">
      // Record-reading widget: queries the 'incidents' collection via the widget runtime.
      const api = globalThis.worktable;
      const el = document.getElementById("list");
      const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
      try {
        const result = api ? await api.records.query("incidents", { where: { status: "open" } }) : [];
        const records = Array.isArray(result) ? result : (result.records || []);
        el.innerHTML = records.length
          ? records.map((r) => { const severity = String(r.data.severity || "?"); const severityClass = ["sev1", "sev2", "sev3"].includes(severity) ? severity : ""; return '<div class="row"><span class="sev ' + severityClass + '">' + escapeHtml(severity) + "</span><span>" + escapeHtml(r.data.title || r.id) + "</span></div>"; }).join("")
          : "<p>No open incidents 🎉</p>";
      } catch (e) {
        el.textContent = "Incident board needs the Worktable record runtime.";
      }
    </script>
  </body>
</html>
`

const engineer: FixtureDef = {
  name: "engineer",
  proves:
    "records (incidents + services, with a reference field), a record-reading widget, a mermaid BlockNote doc, and an open instruction annotation as a ready-made Agent Lab task",
  workspace: { id: "ws_fixture_engineer", name: "Platform Engineering" },
  async build(b: FixtureBuilder) {
    await b.space({
      id: "platform",
      name: "Platform Engineering",
      description: "Payments platform team workspace.",
    })

    // --- Record collections -------------------------------------------------
    await b.recordCollection("platform", {
      id: "services",
      name: "Services",
      description: "Owned services and their tier.",
      fields: {
        name: { type: "string", required: true },
        tier: {
          type: "enum",
          values: ["tier-1", "tier-2", "tier-3"],
          required: true,
        },
        owner: { type: "string" },
      },
    })
    await b.recordCollection("platform", {
      id: "incidents",
      name: "Incidents",
      description: "Production incidents, linked to the affected service.",
      fields: {
        title: { type: "string", required: true },
        severity: {
          type: "enum",
          values: ["sev1", "sev2", "sev3"],
          required: true,
        },
        status: {
          type: "enum",
          values: ["open", "mitigated", "resolved"],
          required: true,
        },
        service: { type: "reference", references: "services" },
        openedAt: { type: "datetime" },
      },
    })

    const services = [
      {
        id: "payments-api",
        name: "Payments API",
        tier: "tier-1",
        owner: "payments-core",
      },
      { id: "ledger", name: "Ledger", tier: "tier-1", owner: "payments-core" },
      {
        id: "webhooks",
        name: "Webhooks",
        tier: "tier-2",
        owner: "integrations",
      },
      { id: "reporting", name: "Reporting", tier: "tier-3", owner: "data" },
    ]
    for (const s of services) {
      await b.record("platform", "services", {
        id: s.id,
        data: { name: s.name, tier: s.tier, owner: s.owner },
      })
    }

    const incidents = [
      {
        id: "inc-001",
        title: "Elevated 5xx on charge endpoint",
        severity: "sev1",
        status: "resolved",
        service: "payments-api",
        openedAt: "2025-11-02T09:14:00.000Z",
      },
      {
        id: "inc-002",
        title: "Duplicate webhook deliveries",
        severity: "sev2",
        status: "mitigated",
        service: "webhooks",
        openedAt: "2025-11-09T16:40:00.000Z",
      },
      {
        id: "inc-003",
        title: "Ledger reconciliation lag",
        severity: "sev2",
        status: "open",
        service: "ledger",
        openedAt: "2025-11-15T02:05:00.000Z",
      },
      {
        id: "inc-004",
        title: "Idempotency key collisions",
        severity: "sev1",
        status: "open",
        service: "payments-api",
        openedAt: "2025-11-18T11:22:00.000Z",
      },
      {
        id: "inc-005",
        title: "Reporting export timeouts",
        severity: "sev3",
        status: "resolved",
        service: "reporting",
        openedAt: "2025-10-28T20:00:00.000Z",
      },
    ]
    for (const i of incidents) {
      await b.record("platform", "incidents", {
        id: i.id,
        data: {
          title: i.title,
          severity: i.severity,
          status: i.status,
          service: i.service,
          openedAt: i.openedAt,
        },
      })
    }

    // --- Docs ---------------------------------------------------------------
    await b.docMd(
      "platform",
      "decisions/adr-001-idempotency-keys",
      "# ADR-001: Idempotency keys for write endpoints\n\n## Status\nAccepted\n\n## Context\nPayment write endpoints must be safe to retry. Network retries and at-least-once webhook delivery cause duplicate submissions.\n\n## Decision\nEvery mutating endpoint requires an `Idempotency-Key` header. The key + request fingerprint is stored for 24h; a repeat returns the original response.\n\n## Consequences\n- Clients must generate stable keys.\n- See incident `inc-004` for a collision edge case.\n"
    )
    await b.docMd(
      "platform",
      "decisions/adr-002-rate-limiting",
      "# ADR-002: Token-bucket rate limiting at the edge\n\n## Status\nAccepted\n\n## Decision\nRate limit per API key with a token bucket at the edge proxy, not in the application. Tier-1 services get a dedicated bucket.\n\n## Consequences\nProtects the Payments API (tier-1) from noisy neighbors; reporting (tier-3) is shed first under load.\n"
    )
    await b.docMd(
      "platform",
      "runbooks/payment-failures",
      "# Runbook: spike in payment failures\n\n## Detect\nAlert: `charge_5xx_rate > 1%` for 5m.\n\n## Triage\n1. Check the **Incident Board** widget for open sev1/sev2.\n2. Inspect the Payments API dashboards.\n3. Confirm the Ledger is keeping up (see `inc-003`).\n\n## Mitigate\n- Shed tier-3 traffic (ADR-002).\n- Enable idempotent replay (ADR-001).\n\n## Communicate\nPost status updates every 15 minutes.\n"
    )
    await b.docJson(
      "platform",
      "architecture/overview",
      blockDoc(
        {
          id: "h-arch",
          type: "heading",
          level: 1,
          text: "Payments architecture",
        },
        {
          id: "p-arch",
          type: "paragraph",
          text: "High-level request flow. This doc is BlockNote (.json) and embeds a mermaid diagram, proving rich blocks survive a copy.",
        },
        {
          id: "m-arch",
          type: "mermaid",
          title: "Payments request flow",
          text: "graph LR\n  client[Client] --> edge[Edge proxy]\n  edge --> api[Payments API]\n  api --> ledger[Ledger]\n  api --> hooks[Webhooks]\n  api --> reporting[Reporting]",
        }
      )
    )

    // --- Widget (record-reading) -------------------------------------------
    await b.widget("platform", {
      id: "incident-board",
      name: "Incident Board",
      description: "Lists open incidents from the incidents collection.",
      html: INCIDENT_BOARD_HTML,
      permissions: {
        network: false,
        records: { incidents: { read: true } },
        state: { read: true, write: true },
      },
    })

    // --- Annotation: a ready-made Agent Lab task ---------------------------
    b.annotation("platform", {
      id: "ann_engineer_runbook_task",
      docPath: "runbooks/payment-failures",
      category: "instruction",
      body: "Summarize the last three incidents (see the incidents collection) and propose a 5-item prevention checklist. Save it as a new doc in this space.",
      author: { type: "user", id: "lead", name: "Eng Lead" },
      labels: ["agent-task"],
    })
  },
}

/** Minimal self-contained record-list widget HTML, parameterized by collection + title. */
function recordListWidgetHtml(collection: string, title: string): string {
  return `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>${title}</title>
    <style>body{font:14px system-ui,sans-serif;margin:0;padding:16px}h1{font-size:16px;margin:0 0 12px}.row{padding:6px 0;border-bottom:1px solid #eee}</style>
  </head>
  <body>
    <h1>${title}</h1>
    <div id="list">Loading…</div>
    <script type="module">
      const api = globalThis.worktable;
      const el = document.getElementById("list");
      const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
      try {
        const result = api ? await api.records.query(${JSON.stringify(collection)}) : [];
        const records = Array.isArray(result) ? result : (result.records || []);
        el.innerHTML = records.length
          ? records.map((r) => '<div class="row">' + escapeHtml(r.data.title || r.data.objective || r.data.role || r.id) + "</div>").join("")
          : "<p>No records yet.</p>";
      } catch (e) { el.textContent = "Needs the Worktable record runtime."; }
    </script>
  </body>
</html>
`
}

const COMPANY_PULSE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>Company pulse</title>
    <style>
      :root{color-scheme:light;--pulse-bg:#f7f7f5;--pulse-surface:#fff;--pulse-surface-2:#f1f2ef;--pulse-text:#202329;--pulse-muted:#6f747c;--pulse-border:#dedfda;--pulse-accent:#155eef;--pulse-good:#087a55;--pulse-good-bg:#e9f7f0;--pulse-warn:#a15c00;--pulse-warn-bg:#fff4df;--pulse-bad:#b42318;--pulse-bad-bg:#ffebe9;--pulse-shadow:0 16px 40px rgba(32,35,41,.07)}
      html[data-theme="dark"]{color-scheme:dark;--pulse-bg:#0d1013;--pulse-surface:#14181c;--pulse-surface-2:#1b2025;--pulse-text:#eef0f2;--pulse-muted:#9aa1aa;--pulse-border:#2b3138;--pulse-accent:#78a6ff;--pulse-good:#68d7ad;--pulse-good-bg:#12382d;--pulse-warn:#ffc56e;--pulse-warn-bg:#3c2a0f;--pulse-bad:#ff938a;--pulse-bad-bg:#421d1a;--pulse-shadow:none}
      *{box-sizing:border-box}body{margin:0;background:var(--pulse-bg);color:var(--pulse-text);font:14px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.shell{max-width:1180px;margin:0 auto;padding:32px}.eyebrow{margin:0 0 6px;color:var(--pulse-accent);font-size:11px;font-weight:750;letter-spacing:.12em;text-transform:uppercase}.top{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;margin-bottom:22px}h1{margin:0;font-size:28px;letter-spacing:-.03em}.lede{margin:6px 0 0;color:var(--pulse-muted)}.updated{color:var(--pulse-muted);font-size:12px;white-space:nowrap}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin-bottom:16px}.metric,.panel{border:1px solid var(--pulse-border);background:var(--pulse-surface);box-shadow:var(--pulse-shadow)}.metric{border-radius:14px;padding:16px}.metric-label{color:var(--pulse-muted);font-size:12px}.metric-value{margin-top:5px;font-size:25px;font-weight:720;letter-spacing:-.03em}.metric-detail{margin-top:3px;color:var(--pulse-muted);font-size:12px}.grid{display:grid;grid-template-columns:minmax(0,1.65fr) minmax(280px,.85fr);gap:16px}.panel{border-radius:16px;overflow:hidden}.panel-head{display:flex;align-items:center;justify-content:space-between;padding:16px 18px;border-bottom:1px solid var(--pulse-border)}h2{margin:0;font-size:14px}.panel-note{color:var(--pulse-muted);font-size:12px}.objectives{padding:4px 18px}.objective{padding:15px 0;border-bottom:1px solid var(--pulse-border)}.objective:last-child{border-bottom:0}.objective-top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.objective-name{font-weight:680}.kr{margin-top:3px;color:var(--pulse-muted);font-size:12px}.owner{color:var(--pulse-muted);font-size:11px;text-transform:capitalize}.status{display:inline-flex;align-items:center;border-radius:999px;padding:3px 8px;font-size:11px;font-weight:700;white-space:nowrap}.status.on-track{background:var(--pulse-good-bg);color:var(--pulse-good)}.status.at-risk{background:var(--pulse-warn-bg);color:var(--pulse-warn)}.status.off-track{background:var(--pulse-bad-bg);color:var(--pulse-bad)}.progress-row{display:flex;align-items:center;gap:10px;margin-top:10px}.track{height:7px;flex:1;overflow:hidden;border-radius:999px;background:var(--pulse-surface-2)}.fill{height:100%;border-radius:inherit;background:var(--pulse-accent)}.pct{width:34px;text-align:right;font-size:12px;font-variant-numeric:tabular-nums}.hiring{padding:10px 18px 16px}.candidate{display:grid;grid-template-columns:1fr auto;gap:4px 12px;padding:11px 0;border-bottom:1px solid var(--pulse-border)}.candidate:last-child{border-bottom:0}.candidate-name{font-weight:650}.candidate-role,.candidate-next{color:var(--pulse-muted);font-size:12px}.stage{align-self:center;border-radius:8px;background:var(--pulse-surface-2);padding:4px 7px;font-size:11px;font-weight:650;text-transform:capitalize}.empty,.error{padding:28px 18px;color:var(--pulse-muted);text-align:center}.footer{display:flex;justify-content:space-between;margin-top:14px;color:var(--pulse-muted);font-size:11px}@media(max-width:760px){.shell{padding:20px}.top{align-items:flex-start;flex-direction:column}.metrics{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}}@media(max-width:460px){.metrics{grid-template-columns:1fr}}
    </style>
  </head>
  <body>
    <main class="shell">
      <div class="top"><div><p class="eyebrow">Operating review</p><h1>Company pulse</h1><p class="lede">The handful of outcomes and hires that need attention this week.</p></div><div class="updated">Live from Worktable records</div></div>
      <section class="metrics" id="metrics"><div class="metric"><div class="metric-label">Loading company data…</div></div></section>
      <section class="grid"><article class="panel"><div class="panel-head"><h2>Company objectives</h2><span class="panel-note">Q3</span></div><div class="objectives" id="objectives"></div></article><aside class="panel"><div class="panel-head"><h2>Hiring pipeline</h2><span class="panel-note" id="candidate-count"></span></div><div class="hiring" id="hiring"></div></aside></section>
      <div class="footer"><span>Sources: OKRs and Hiring pipeline</span><span>Changes update automatically</span></div>
    </main>
    <script type="module">
      const api=globalThis.worktable;
      const escapeHtml=(value)=>String(value??"").replace(/[&<>"']/g,(char)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]);
      const percent=(value)=>Math.max(0,Math.min(100,Math.round(Number(value||0)*100)));
      const label=(value)=>String(value||"").replaceAll("-"," ");
      const normalize=(result)=>Array.isArray(result)?result:(result.records||[]);
      let okrs=[];
      let candidates=[];
      const render=()=>{
        okrs.sort((a,b)=>percent(b.data.progress)-percent(a.data.progress));
        candidates=candidates.filter((item)=>item.data.stage!=="closed");
        const avg=okrs.length?Math.round(okrs.reduce((sum,item)=>sum+percent(item.data.progress),0)/okrs.length):0;
        const onTrack=okrs.filter((item)=>item.data.status==="on-track").length;
        const attention=okrs.length-onTrack;
        const lateStage=candidates.filter((item)=>["onsite","offer"].includes(item.data.stage)).length;
        document.getElementById("metrics").innerHTML=[
          [avg+"%","Average progress",okrs.length+" active objectives"],
          [onTrack,"On track",attention+" need attention"],
          [candidates.length,"Active candidates",lateStage+" in late stages"],
          ["2","Decisions due","Activation and enterprise readiness"]
        ].map(([value,name,detail])=>'<div class="metric"><div class="metric-label">'+escapeHtml(name)+'</div><div class="metric-value">'+escapeHtml(value)+'</div><div class="metric-detail">'+escapeHtml(detail)+'</div></div>').join("");
        document.getElementById("objectives").innerHTML=okrs.length?okrs.map((item)=>{const data=item.data;const progress=percent(data.progress);return '<div class="objective"><div class="objective-top"><div><div class="objective-name">'+escapeHtml(data.objective)+'</div><div class="kr">'+escapeHtml(data.keyResult)+'</div><div class="owner">'+escapeHtml(data.owner)+'</div></div><span class="status '+escapeHtml(data.status)+'">'+escapeHtml(label(data.status))+'</span></div><div class="progress-row"><div class="track"><div class="fill" style="width:'+progress+'%"></div></div><span class="pct">'+progress+'%</span></div></div>'}).join(""):'<div class="empty">No objectives yet.</div>';
        const stageOrder={offer:0,onsite:1,screening:2,sourcing:3,closed:4};
        candidates.sort((a,b)=>(stageOrder[a.data.stage]??9)-(stageOrder[b.data.stage]??9));
        document.getElementById("candidate-count").textContent=candidates.length+" active";
        document.getElementById("hiring").innerHTML=candidates.length?candidates.slice(0,7).map((item)=>'<div class="candidate"><div><div class="candidate-name">'+escapeHtml(item.data.candidate||item.data.role)+'</div><div class="candidate-role">'+escapeHtml(item.data.role)+'</div></div><span class="stage">'+escapeHtml(label(item.data.stage))+'</span><div class="candidate-next">'+escapeHtml(item.data.nextStep||"")+'</div></div>').join(""):'<div class="empty">No active candidates.</div>';
      };
      try{
        const [okrResult,hiringResult]=api?await Promise.all([api.records.query("okrs"),api.records.query("hiring-pipeline")]):[[],[]];
        okrs=normalize(okrResult);
        candidates=normalize(hiringResult);
        render();
        if(api){
          api.records.subscribe("okrs",{},(nextRecords)=>{okrs=normalize(nextRecords);render()});
          api.records.subscribe("hiring-pipeline",{},(nextRecords)=>{candidates=normalize(nextRecords);render()});
        }
      }catch(error){document.getElementById("metrics").innerHTML='<div class="metric"><div class="metric-label">Company data is unavailable.</div><div class="metric-detail">Open the source collections to check their status.</div></div>';document.getElementById("objectives").innerHTML='<div class="error">Could not load objectives.</div>';document.getElementById("hiring").innerHTML='<div class="error">Could not load hiring.</div>';}
    </script>
  </body>
</html>`

const productManager: FixtureDef = {
  name: "product-manager",
  proves:
    "a believable PM workspace: PRDs, roadmap + feedback collections (feedback references roadmap), a roadmap widget, and a cross-linking comment annotation",
  workspace: { id: "ws_fixture_product_manager", name: "Mobile App PM" },
  async build(b: FixtureBuilder) {
    await b.space({
      id: "product",
      name: "Product",
      description: "Mobile app product management.",
    })

    await b.recordCollection("product", {
      id: "roadmap",
      name: "Roadmap",
      fields: {
        title: { type: "string", required: true },
        quarter: {
          type: "enum",
          values: ["q1", "q2", "q3", "q4"],
          required: true,
        },
        status: {
          type: "enum",
          values: ["planned", "in-progress", "shipped"],
          required: true,
        },
        owner: { type: "string" },
      },
    })
    await b.recordCollection("product", {
      id: "feedback",
      name: "Feedback",
      fields: {
        summary: { type: "string", required: true },
        source: {
          type: "enum",
          values: ["app-store", "support", "interview"],
          required: true,
        },
        sentiment: {
          type: "enum",
          values: ["positive", "neutral", "negative"],
          required: true,
        },
        feature: { type: "reference", references: "roadmap" },
      },
    })

    for (const r of [
      {
        id: "offline-mode",
        title: "Offline mode",
        quarter: "q1",
        status: "in-progress",
        owner: "mobile",
      },
      {
        id: "push-v2",
        title: "Push notifications v2",
        quarter: "q2",
        status: "planned",
        owner: "growth",
      },
      {
        id: "dark-theme",
        title: "Dark theme",
        quarter: "q1",
        status: "shipped",
        owner: "design",
      },
      {
        id: "share-sheet",
        title: "Native share sheet",
        quarter: "q3",
        status: "planned",
        owner: "mobile",
      },
    ]) {
      await b.record("product", "roadmap", {
        id: r.id,
        data: {
          title: r.title,
          quarter: r.quarter,
          status: r.status,
          owner: r.owner,
        },
      })
    }
    for (const f of [
      {
        id: "fb-001",
        summary: "Wants to use the app on the subway",
        source: "app-store",
        sentiment: "negative",
        feature: "offline-mode",
      },
      {
        id: "fb-002",
        summary: "Loves the new dark theme",
        source: "app-store",
        sentiment: "positive",
        feature: "dark-theme",
      },
      {
        id: "fb-003",
        summary: "Notifications are too noisy",
        source: "support",
        sentiment: "negative",
        feature: "push-v2",
      },
      {
        id: "fb-004",
        summary: "Asked for a quick share button",
        source: "interview",
        sentiment: "neutral",
        feature: "share-sheet",
      },
    ]) {
      await b.record("product", "feedback", {
        id: f.id,
        data: {
          summary: f.summary,
          source: f.source,
          sentiment: f.sentiment,
          feature: f.feature,
        },
      })
    }

    await b.docMd(
      "product",
      "prds/offline-mode",
      "# PRD: Offline mode\n\n## Problem\nUsers lose access on the subway and in flights. App-store reviews (see the feedback collection) repeatedly ask for offline access.\n\n## Goals\n- Read cached content offline\n- Queue actions, sync on reconnect\n\n## Non-goals\nFull offline editing of every surface.\n\n## Success metric\n30-day retention for commuters +5%.\n"
    )
    await b.docMd(
      "product",
      "research/q1-interviews",
      "# Q1 user interviews — summary\n\nSix interviews with daily commuters.\n\n## Themes\n1. Offline access is the top unmet need.\n2. Notifications feel noisy (see `push-v2`).\n3. Sharing is awkward.\n\n## Next\nPrioritize offline mode for Q1.\n"
    )
    await b.docJson(
      "product",
      "vision",
      blockDoc(
        { id: "h-vis", type: "heading", level: 1, text: "Product vision" },
        {
          id: "p-vis",
          type: "paragraph",
          text: "The fastest way to capture and revisit on the go — even offline.",
        }
      )
    )

    await b.widget("product", {
      id: "roadmap-timeline",
      name: "Roadmap",
      description: "Lists roadmap items by quarter.",
      html: recordListWidgetHtml("roadmap", "Roadmap"),
      permissions: {
        network: false,
        records: { roadmap: { read: true } },
        state: { read: true, write: true },
      },
    })

    b.annotation("product", {
      id: "ann_pm_prd_comment",
      docPath: "prds/offline-mode",
      category: "comment",
      body: "Tie this PRD to roadmap item `offline-mode` (q1, in-progress) and the negative app-store feedback `fb-001`.",
      author: { type: "user", id: "pm", name: "PM" },
    })
  },
}

const founder: FixtureDef = {
  name: "founder",
  proves:
    "a lived-in company operating system across Company and Board spaces: substantial strategy and operating docs, six OKRs, a detailed hiring pipeline, a live company-pulse dashboard, annotations, and realistic human-agent threads",
  workspace: { id: "ws_fixture_founder", name: "Founder" },
  async build(b: FixtureBuilder) {
    await b.space({
      id: "company",
      name: "Company",
      description: "Strategy, operating reviews, customers, and team planning.",
    })
    await b.space({
      id: "board",
      name: "Board",
      description: "Updates, decisions, and meeting materials.",
    })

    await b.recordCollection("company", {
      id: "okrs",
      name: "OKRs",
      fields: {
        objective: { type: "string", required: true },
        keyResult: { type: "string", required: true },
        owner: { type: "string" },
        status: {
          type: "enum",
          values: ["on-track", "at-risk", "off-track"],
          required: true,
        },
        progress: { type: "number" },
        trend: { type: "enum", values: ["improving", "steady", "declining"] },
        reviewDate: { type: "date" },
      },
    })
    await b.recordCollection("company", {
      id: "hiring-pipeline",
      name: "Hiring pipeline",
      fields: {
        role: { type: "string", required: true },
        candidate: { type: "string", required: true },
        stage: {
          type: "enum",
          values: ["sourcing", "screening", "onsite", "offer", "closed"],
          required: true,
        },
        owner: { type: "string" },
        priority: { type: "enum", values: ["critical", "high", "normal"] },
        nextStep: { type: "string" },
        nextInterview: { type: "date" },
      },
    })

    for (const o of [
      {
        id: "okr-revenue",
        objective: "Build a repeatable revenue engine",
        keyResult: "Close 40 paying teams and reach $1M ARR",
        owner: "Maya",
        status: "on-track",
        progress: 0.68,
        trend: "improving",
        reviewDate: "2026-09-25",
      },
      {
        id: "okr-activation",
        objective: "Make the first week feel indispensable",
        keyResult: "Raise team activation from 34% to 50%",
        owner: "Inez",
        status: "at-risk",
        progress: 0.42,
        trend: "improving",
        reviewDate: "2026-09-18",
      },
      {
        id: "okr-reliability",
        objective: "Earn trust with dependable collaboration",
        keyResult:
          "Maintain 99.95% sync success and resolve P1s within 30 minutes",
        owner: "Dev",
        status: "on-track",
        progress: 0.81,
        trend: "steady",
        reviewDate: "2026-09-23",
      },
      {
        id: "okr-enterprise",
        objective: "Become ready for larger teams",
        keyResult:
          "Complete SSO, audit logs, and three enterprise design partnerships",
        owner: "Maya",
        status: "at-risk",
        progress: 0.54,
        trend: "declining",
        reviewDate: "2026-09-16",
      },
      {
        id: "okr-hiring",
        objective: "Build the founding team deliberately",
        keyResult: "Hire three engineers and one product designer",
        owner: "Maya",
        status: "on-track",
        progress: 0.6,
        trend: "improving",
        reviewDate: "2026-09-22",
      },
      {
        id: "okr-support",
        objective: "Turn customer support into product learning",
        keyResult: "Respond within four hours and tag 90% of product signals",
        owner: "Nora",
        status: "on-track",
        progress: 0.73,
        trend: "steady",
        reviewDate: "2026-09-19",
      },
    ]) {
      await b.record("company", "okrs", {
        id: o.id,
        data: {
          objective: o.objective,
          keyResult: o.keyResult,
          owner: o.owner,
          status: o.status,
          progress: o.progress,
          trend: o.trend,
          reviewDate: o.reviewDate,
        },
      })
    }
    for (const h of [
      {
        id: "eng-amara",
        candidate: "Amara Okafor",
        role: "Product engineer",
        stage: "offer",
        owner: "Maya",
        priority: "critical",
        nextStep: "Offer review with references",
        nextInterview: "2026-08-18",
      },
      {
        id: "eng-lucas",
        candidate: "Lucas Meyer",
        role: "Product engineer",
        stage: "onsite",
        owner: "Dev",
        priority: "critical",
        nextStep: "Systems pairing session",
        nextInterview: "2026-08-19",
      },
      {
        id: "eng-priya",
        candidate: "Priya Shah",
        role: "Infrastructure engineer",
        stage: "onsite",
        owner: "Dev",
        priority: "high",
        nextStep: "Founder conversation",
        nextInterview: "2026-08-20",
      },
      {
        id: "design-emi",
        candidate: "Emi Tan",
        role: "Product designer",
        stage: "screening",
        owner: "Inez",
        priority: "high",
        nextStep: "Portfolio walkthrough",
        nextInterview: "2026-08-18",
      },
      {
        id: "eng-sam",
        candidate: "Sam Rivera",
        role: "Product engineer",
        stage: "screening",
        owner: "Dev",
        priority: "critical",
        nextStep: "Technical screen",
        nextInterview: "2026-08-21",
      },
      {
        id: "success-jules",
        candidate: "Jules Martin",
        role: "Customer success lead",
        stage: "sourcing",
        owner: "Nora",
        priority: "normal",
        nextStep: "Warm introduction",
        nextInterview: "2026-08-24",
      },
      {
        id: "design-zoe",
        candidate: "Zoë Bennett",
        role: "Product designer",
        stage: "sourcing",
        owner: "Inez",
        priority: "high",
        nextStep: "Review work samples",
        nextInterview: "2026-08-25",
      },
      {
        id: "eng-noah",
        candidate: "Noah Williams",
        role: "Infrastructure engineer",
        stage: "closed",
        owner: "Dev",
        priority: "high",
        nextStep: "Keep warm for Q2",
        nextInterview: "2026-08-10",
      },
    ]) {
      await b.record("company", "hiring-pipeline", {
        id: h.id,
        data: {
          candidate: h.candidate,
          role: h.role,
          stage: h.stage,
          owner: h.owner,
          priority: h.priority,
          nextStep: h.nextStep,
          nextInterview: h.nextInterview,
        },
      })
    }

    await b.docMd(
      "company",
      "vision",
      "# Vision\n\nBuild the place where a team and its agents can do serious work together without giving up ownership of their knowledge.\n\n## The change we believe in\n\nAgents are becoming collaborators, but most teams still hand them context one prompt at a time. Decisions disappear into chats, generated work lands outside the operating system, and people cannot tell what is current or trustworthy.\n\nWorktable gives both sides durable shared context: documents for thinking, records for operating data, HTML views for purpose-built tools, annotations for precise direction, and threads for the work around all of it. Everything remains legible as files.\n\n## Who we serve first\n\nSmall, high-agency teams already using agents in product, operations, and engineering. They value speed, but they need provenance and control more than another blank chat box.\n\n## Three-year picture\n\n- A team opens Worktable to understand what matters now.\n- Agents can find the same source material, act on it, and leave inspectable results.\n- Decisions stay connected to the documents and records they changed.\n- Moving or backing up the work never requires permission from us.\n\n## What we will not compromise\n\n1. People can inspect and own their data.\n2. Agent work is attributable and reviewable.\n3. The product stays calm as the amount of work grows.\n4. Powerful workflows do not require a platform team.\n"
    )
    await b.docMd(
      "company",
      "okrs/q3",
      "# Q3 operating plan\n\nThe `okrs` collection is the live source for status. This document holds the reasoning and tradeoffs behind the numbers.\n\n## Quarter thesis\n\nProve that teams return because Worktable becomes part of how they operate, not because a single demo is impressive. Revenue, activation, reliability, enterprise readiness, hiring, and customer learning are one system this quarter.\n\n## Current read\n\n| Objective | Progress | Read |\n| --- | ---: | --- |\n| Repeatable revenue engine | 68% | Healthy pipeline; conversion quality matters more than volume. |\n| Indispensable first week | 42% | Improving, but still the largest company risk. |\n| Dependable collaboration | 81% | On track; keep reliability work ahead of growth. |\n| Enterprise readiness | 54% | At risk after audit-log scope expanded. |\n| Founding team | 60% | One offer and two onsites in motion. |\n| Support as product learning | 73% | Response time is healthy; signal tagging needs consistency. |\n\n## Decisions for this week\n\n1. Keep the activation team focused on the first shared artifact, not broader onboarding polish.\n2. Ship audit-log export before adding more SSO providers.\n3. Close the product-engineer offer before opening another role.\n\n## Risks\n\n- Enterprise work can consume the product roadmap if design partners do not share a common need.\n- Activation experiments are moving the metric, but the sample is still small.\n- Founder time is split across sales and late-stage hiring.\n\n## Review rhythm\n\nOwners update records by Thursday. Leadership resolves changes in [the weekly review](/leadership/weekly-review) on Friday, then the dashboard becomes the Monday operating view.\n"
    )
    await b.docMd(
      "company",
      "leadership/weekly-review",
      "# Weekly leadership review\n\n## Snapshot\n\n- **Revenue:** 31 paying teams, with 6 in contracting.\n- **Activation:** 42% of new teams create and revisit a shared artifact in week one.\n- **Reliability:** 99.97% successful sync sessions over the last seven days.\n- **Hiring:** One offer, two onsites, and two screens active.\n\n## What changed\n\nThe guided first-space experiment improved initial setup completion, but the largest drop now happens after a person creates their first document and before they invite a collaborator. Two enterprise design partners independently prioritized audit-log export over additional SSO providers.\n\n## Decisions\n\n- Make sharing the next activation milestone and postpone template browsing changes.\n- Use one audit-log export format for Northstar and Cascade.\n- Extend Amara's offer window by two days so references can finish.\n\n## Needs attention\n\n### Activation\n\nInez will bring three invitation-flow options and a measurement plan. Atlas will summarize the last ten onboarding interviews against those options.\n\n### Enterprise readiness\n\nMaya will confirm whether Northstar and Cascade can accept the same export schema. Dev will estimate the smallest end-to-end slice.\n\n### Hiring\n\nThe team needs an interviewer for Thursday's systems pairing session. The hiring pipeline has the latest schedule and next step for every candidate.\n\n## Next review\n\nOwners update the `okrs` and `hiring-pipeline` collections before Friday at noon. Capture any decision that changes scope in this document.\n"
    )
    await b.docMd(
      "company",
      "customers/design-partner-notes",
      "# Enterprise design partner notes\n\n## Northstar Logistics\n\n- **Team:** 180 people across operations, finance, and product\n- **Primary need:** A durable record of agent-made changes for compliance review\n- **Current workaround:** Weekly exports from three separate tools\n\nThey do not need a broad admin console yet. They need to answer who changed a document, what changed, and whether a person reviewed it.\n\n## Cascade Health\n\n- **Team:** 95 people, with a six-person security group\n- **Primary need:** Audit evidence and predictable access removal\n- **Current workaround:** Screenshots attached to quarterly access reviews\n\nTheir strongest reaction was to provenance in the document header. They asked whether the same history could be exported for an auditor.\n\n## Fieldcraft Studio\n\n- **Team:** 42 people using agents heavily in client delivery\n- **Primary need:** Separate client spaces without duplicating operating templates\n- **Current workaround:** One folder tree per client and a manual setup checklist\n\nThey are a better design partner for reusable structures than for identity work. Keep their requests out of the Q3 enterprise-readiness scope.\n\n## Shared signal\n\nNorthstar and Cascade can use the same first audit-log export if it includes actor, source, timestamp, artifact, and review status. That is the next decision to validate.\n"
    )
    await b.docJson(
      "company",
      "strategy/growth-loop",
      blockDoc(
        {
          id: "h-growth",
          type: "heading",
          level: 1,
          text: "The collaboration growth loop",
        },
        {
          id: "p-growth-1",
          type: "paragraph",
          text: "The product grows when one person's useful artifact becomes shared team context, then gives an agent enough context to produce the next useful result.",
        },
        { id: "h-growth-2", type: "heading", level: 2, text: "Working model" },
        {
          id: "m-growth",
          type: "mermaid",
          title: "Collaboration loop",
          text: "flowchart LR\n  create[Create useful work] --> share[Share with a teammate]\n  share --> context[Build shared context]\n  context --> agent[Delegate to an agent]\n  agent --> review[Review the result]\n  review --> create",
        },
        {
          id: "h-growth-3",
          type: "heading",
          level: 2,
          text: "What we measure",
        },
        {
          id: "p-growth-2",
          type: "paragraph",
          text: "First shared artifact, first returning collaborator, first accepted agent contribution, and weekly teams with all three.",
        }
      )
    )
    await b.docMd(
      "board",
      "updates/2026-q3",
      "# Board update — Q3 2026\n\n## Executive summary\n\nThe company is on plan for revenue, reliability, and hiring. Activation is improving but remains the main operating risk. Enterprise demand is real enough to pursue through three design partners, provided we keep the first delivery narrow.\n\n## Scorecard\n\n- **31 paying teams**, up from 22 at the start of the quarter.\n- **$720K ARR**, with six teams in contracting.\n- **42% activation**, up eight points but below the 50% target.\n- **99.97% sync success** over the last month.\n- **One accepted hire and one active offer** this quarter.\n\n## What is working\n\nTeams with one shared document and one connected agent in their first week retain at roughly twice the baseline. Design partners understand the local-first story quickly when they see files, provenance, and version history together.\n\n## What is not yet working\n\nToo many new teams create something useful but never bring another person into it. The product currently explains creation better than collaboration. Enterprise requests can also look similar at the headline level while hiding very different workflows.\n\n## Q4 choices\n\n1. Concentrate onboarding on the first shared artifact.\n2. Deliver a narrow audit-log export for Northstar and Cascade.\n3. Keep reusable client-space templates in discovery until activation clears 50%.\n\n## Board asks\n\n- Two introductions to product-led infrastructure companies with 50–200 employees.\n- One security leader willing to review the proposed audit export.\n- Feedback on whether to begin the Series A process before or after the Q3 activation milestone.\n"
    )
    await b.docMd(
      "board",
      "meetings/2026-08-28-agenda",
      "# Board meeting agenda — August 28\n\n## Pre-read\n\n- [Q3 board update](/updates/2026-q3)\n- Company pulse dashboard\n- Enterprise design partner notes\n\n## Agenda\n\n1. Operating scorecard and activation trend — 20 min\n2. Enterprise scope decision — 20 min\n3. Hiring plan and runway scenarios — 15 min\n4. Fundraising timing — 20 min\n5. Closed session — 15 min\n\n## Decisions requested\n\n- Endorse the narrow audit-log export as the only Q4 enterprise commitment.\n- Confirm the trigger for beginning a Series A process.\n- Approve one additional infrastructure-engineering headcount if the current offer closes.\n"
    )

    await b.widget("company", {
      id: "okr-dashboard",
      name: "Company pulse",
      description: "A live weekly view of company objectives and hiring.",
      html: COMPANY_PULSE_HTML,
      permissions: {
        network: false,
        records: { okrs: { read: true }, "hiring-pipeline": { read: true } },
        state: { read: true, write: true },
      },
    })

    b.annotation("company", {
      id: "ann_founder_activation_task",
      docPath: "okrs/q3",
      category: "instruction",
      body: "Draft a 1-page activation plan to move the at-risk OKR (`okr-activation`) from 42% to 50%. Save it in the Company space.",
      author: { type: "user", id: "ceo", name: "Founder" },
      labels: ["agent-task"],
    })
    b.annotation("company", {
      id: "ann_founder_weekly_review",
      docPath: "strategy/growth-loop",
      category: "comment",
      body: "Add the owner and expected readout date for the first sharing experiment before Monday's operating review.",
      author: { type: "user", id: "founder", name: "Maya" },
    })
    b.annotation("company", {
      id: "ann_founder_design_partners",
      docPath: "strategy/growth-loop",
      category: "instruction",
      body: "Use the design partner notes and activation thread to challenge this loop. Reply with one missing step and the metric that would tell us it is working.",
      author: { type: "user", id: "founder", name: "Maya" },
      labels: ["agent-task", "enterprise"],
    })

    const maya = {
      id: "ptc_founder_maya01",
      kind: "human" as const,
      name: "Maya",
    }
    const inez = {
      id: "ptc_founder_inez01",
      kind: "human" as const,
      name: "Inez",
    }
    const atlas = {
      id: "ptc_founder_atlas01",
      kind: "agent" as const,
      name: "Atlas",
    }
    const scout = {
      id: "ptc_founder_scout01",
      kind: "agent" as const,
      name: "Scout",
    }
    fixtureThread({
      id: "thr_founder_activation01",
      title: "Activation review: the gap after first value",
      location: { kind: "space", spaceId: "company" },
      participants: [inez, atlas],
      messages: [
        {
          id: "msg_founder_activation01",
          authorId: inez.id,
          recipientIds: [atlas.id],
          body: "Review the last ten onboarding interviews and group the reasons people stop after creating their first useful document.",
          expectsReply: true,
          idempotencyKey: "founder-activation-1",
          createdAt: "2026-08-12T14:00:00.000Z",
        },
        {
          id: "msg_founder_activation02",
          authorId: atlas.id,
          recipientIds: [inez.id],
          body: "The interviews cluster into three gaps: no clear person to invite, uncertainty about what collaborators will see, and no obvious next task after the document exists. Six of ten teams described the first gap.",
          inReplyTo: "msg_founder_activation01",
          expectsReply: false,
          idempotencyKey: "founder-activation-2",
          createdAt: "2026-08-12T14:08:00.000Z",
        },
        {
          id: "msg_founder_activation03",
          authorId: inez.id,
          recipientIds: [atlas.id],
          body: "Compare that with the activation record and propose two experiments we can read within a week. Keep them focused on sharing rather than templates.",
          expectsReply: true,
          idempotencyKey: "founder-activation-3",
          createdAt: "2026-08-12T14:16:00.000Z",
        },
        {
          id: "msg_founder_activation04",
          authorId: atlas.id,
          recipientIds: [inez.id],
          body: "I recommend an invite prompt immediately after the first revisit, and a collaborator preview beside the Share action. Measure invited teammates per activated team and the share-to-return rate. I added the evidence and proposed thresholds to the weekly review.",
          inReplyTo: "msg_founder_activation03",
          expectsReply: false,
          idempotencyKey: "founder-activation-4",
          createdAt: "2026-08-12T14:25:00.000Z",
        },
      ],
    })
    fixtureThread({
      id: "thr_founder_enterprise01",
      title: "Find the common enterprise requirement",
      location: { kind: "space", spaceId: "company" },
      participants: [maya, atlas],
      messages: [
        {
          id: "msg_founder_enterprise01",
          authorId: maya.id,
          recipientIds: [atlas.id],
          body: "Read the design partner notes and tell me where Northstar and Cascade genuinely overlap. Separate shared requirements from requests that only sound similar.",
          expectsReply: true,
          idempotencyKey: "founder-enterprise-1",
          createdAt: "2026-08-13T16:30:00.000Z",
        },
        {
          id: "msg_founder_enterprise02",
          authorId: atlas.id,
          recipientIds: [maya.id],
          body: "The real overlap is a portable audit record with actor, source, timestamp, artifact, action, and human-review status. Northstar's weekly export and Cascade's quarterly evidence package can both consume that. Automated access reviews are Cascade-only; reusable client spaces are Fieldcraft-only.",
          inReplyTo: "msg_founder_enterprise01",
          expectsReply: false,
          idempotencyKey: "founder-enterprise-2",
          createdAt: "2026-08-13T16:38:00.000Z",
        },
        {
          id: "msg_founder_enterprise03",
          authorId: maya.id,
          recipientIds: [atlas.id],
          body: "Draft the narrow validation plan in the partner notes and flag anything that requires a policy decision before engineering estimates it.",
          expectsReply: true,
          idempotencyKey: "founder-enterprise-3",
          createdAt: "2026-08-13T16:45:00.000Z",
        },
        {
          id: "msg_founder_enterprise04",
          authorId: atlas.id,
          recipientIds: [maya.id],
          body: "I added a two-part validation plan to the partner notes: confirm the shared export schema with both teams, then test one sample package in each review workflow. Retention and access-removal policy remain separate decisions before engineering estimates delivery.",
          inReplyTo: "msg_founder_enterprise03",
          expectsReply: false,
          idempotencyKey: "founder-enterprise-4",
          createdAt: "2026-08-13T16:53:00.000Z",
        },
      ],
    })
    fixtureThread({
      id: "thr_founder_boardprep01",
      title: "Prepare the August board discussion",
      location: { kind: "worktable" },
      participants: [maya, atlas],
      messages: [
        {
          id: "msg_founder_boardprep01",
          authorId: maya.id,
          recipientIds: [atlas.id],
          body: "Build a concise board narrative from the operating plan, weekly review, and Q3 update. Lead with the decision we need, not a recap of every metric.",
          expectsReply: true,
          idempotencyKey: "founder-boardprep-1",
          createdAt: "2026-08-14T18:00:00.000Z",
        },
        {
          id: "msg_founder_boardprep02",
          authorId: atlas.id,
          recipientIds: [maya.id],
          body: "Suggested narrative: the core business is progressing, activation remains the constraint, and enterprise pull is worth serving only through one shared audit-export commitment. The board decision is whether that focus is sufficient before fundraising begins.",
          inReplyTo: "msg_founder_boardprep01",
          expectsReply: false,
          idempotencyKey: "founder-boardprep-2",
          createdAt: "2026-08-14T18:07:00.000Z",
        },
        {
          id: "msg_founder_boardprep03",
          authorId: maya.id,
          recipientIds: [atlas.id],
          body: "Good. Add the downside case if activation stalls at 45%, then leave the agenda ready for review.",
          expectsReply: true,
          idempotencyKey: "founder-boardprep-3",
          createdAt: "2026-08-14T18:12:00.000Z",
        },
        {
          id: "msg_founder_boardprep04",
          authorId: atlas.id,
          recipientIds: [maya.id],
          body: "The downside case is now explicit: if activation stalls at 45%, growth remains referral-limited and the enterprise work becomes a costly distraction. The agenda is ready for review with that tradeoff beside the fundraising decision.",
          inReplyTo: "msg_founder_boardprep03",
          expectsReply: false,
          idempotencyKey: "founder-boardprep-4",
          createdAt: "2026-08-14T18:19:00.000Z",
        },
      ],
    })
    fixtureThread({
      id: "thr_founder_launchreview1",
      title: "Launch review: invitation experiment",
      location: { kind: "space", spaceId: "company" },
      participants: [maya, inez, atlas, scout],
      messages: [
        {
          id: "msg_founder_launch001",
          authorId: maya.id,
          recipientIds: [atlas.id],
          body: "@Atlas, turn the interview evidence into a launch recommendation. Keep the decision separate from the supporting detail.",
          expectsReply: true,
          idempotencyKey: "founder-launch-1",
          createdAt: "2026-08-15T15:00:00.000Z",
        },
        {
          id: "msg_founder_launch002",
          authorId: atlas.id,
          recipientIds: [maya.id],
          body: "Recommendation: launch the invite prompt after the first revisit and hold the collaborator preview for the next readout. The prompt addresses the clearest interview signal and gives us a result within one week.",
          inReplyTo: "msg_founder_launch001",
          expectsReply: false,
          idempotencyKey: "founder-launch-2",
          createdAt: "2026-08-15T15:07:00.000Z",
        },
        {
          id: "msg_founder_launch003",
          authorId: inez.id,
          recipientIds: [scout.id],
          notifyParticipantIds: [atlas.id],
          body: "@Scout, check the measurement plan before we commit. @Atlas, the recommendation can stand unless the instrumentation changes the decision.",
          expectsReply: true,
          idempotencyKey: "founder-launch-3",
          createdAt: "2026-08-15T15:12:00.000Z",
        },
        {
          id: "msg_founder_launch004",
          authorId: scout.id,
          recipientIds: [inez.id],
          body: "The plan is measurable as written. Add one guardrail: invited teammates who open the Worktable but never return should not count as successful sharing. That keeps a stronger activation signal from being hidden by invite volume.",
          inReplyTo: "msg_founder_launch003",
          expectsReply: false,
          idempotencyKey: "founder-launch-4",
          createdAt: "2026-08-15T15:18:00.000Z",
        },
      ],
    })
  },
}

export const PERSONA_FIXTURES: FixtureDef[] = [
  engineer,
  productManager,
  founder,
]
