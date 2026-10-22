export const ISOLATED_TOOL_GUIDE = `# Worktable tools

Create a self-contained HTML Doc containing one inert script:

\`\`\`html
<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>
<script type="application/worktable">
const rows = await worktable.records.query('sales');
await worktable.ui.render({ tag: 'section', style: { padding: 24 }, children: [
  { tag: 'h1', children: ['Sales'] },
  ...rows.map(row => ({ tag: 'p', children: [row.data.name] }))
] });
</script>
</body></html>
\`\`\`

Worktable runs only that script in an isolated JavaScript engine, with at most 512 KiB of bundled UTF-8 source. Markup, styles and attributes outside it are ignored. Do not use other scripts, imports, browser objects, fetch, timers, storage or DOM libraries. Ordinary JavaScript data operations, promises, top-level await and the Worktable API below are available. Keep work bounded; excessive CPU, memory or messages stop the tool.

## Views

worktable.ui.render(view) commits a validated view and returns a promise. A view is text, a number, or {tag, key?, props?, style?, on?, children?}. Text is always text. Use standard layout, heading, paragraph, list, table and form tags, plus basic inline SVG shapes and text. Images, resource URLs, HTML strings, style rules and embedded documents are unavailable.

Styles are individual typed values, not CSS strings. Use numeric pixels for dimensions, spacing and border widths; bounded percentages are also available for dimensions. Use layout values such as display: 'grid', gap: 16, gridTemplateColumns: 2, fontSize: 18 and fontFamily: 'sans', 'display' or 'mono'. gridTemplateColumns is an integer from 1 to 12, producing equal-width columns. Colors accept hex values or semantic names: background, surface, surface2, text, muted, border, accent, accentSoft, danger, warning and success. Theme colors come from Worktable.

Controls accept props such as value, placeholder, disabled, checked, multiple, selected and aria-label. Associate text labels by nesting controls in label nodes, and give selects an explicit aria-label. Stable key values preserve focus and text selection through renders; keys are not DOM IDs. Buttons do not submit forms by default.

Use on: {click: 'save'} or input, change and submit with action names, then worktable.ui.on('save', async event => { ... }). Events contain value for text/select controls, values for multiple selects and checked for checkboxes/radios. Actions run only for real visitor input. Update application state and render the next view. Catch rejected data or view operations and show a useful state. The reserved environment action receives {theme, viewport} when the host changes.

worktable.ui.getTheme() returns light or dark. worktable.ui.getViewport() returns {width,height}. Both are initialized before source evaluation. worktable.ui.notify(message) shows a text notice in the host.

## Data

Use worktable.records.query(collectionId, query?) or queryDetailed for the full result. query returns records; queryDetailed also includes pagination and truncation information. Records retain their normal {id,data,metadata} shape where access allows it. Never assume every field is present.

worktable.records.subscribe(collectionId, query?, callback) and subscribeDetailed return an unsubscribe function. They deliver the initial result and later changes. Use subscriptions rather than polling. Stop subscriptions when no longer needed.

Member tools may call records.create(collectionId, data, options?), update(collectionId, recordId, patch), and delete(collectionId, recordId), subject to the document's collection permissions and current member access. A live share is read only: its explicit link grant chooses the rows and fields exposed. Sharing never copies the maker's credentials into the tool.

worktable.state.get(key?) reads state. state.set(key,value) or state.set(patch) writes it. state.update(updater) writes the returned object. State persists for member tools. For visitors it is a tab-local overlay over published defaults, never shared Record data. Image previews are read only and refuse persistent writes.

worktable.navigation.openDocument(spaceRootPath) is available only to members after a real user action. It cannot open external URLs or other documents for visitors.

## Inspection

Save through the existing HTML Doc tools, then use worktable_html_read action render for a read-only PNG. Inspect narrow/wide and light/dark captures and their diagnostics. Separately exercise controls in the real interface, confirm intended member writes by rereading Records, and verify that visitor actions stay within the link's grant. A preview observes current authorized data rather than a historical database snapshot. If rendering fails after a save, retry render instead of repeating the mutation.`
