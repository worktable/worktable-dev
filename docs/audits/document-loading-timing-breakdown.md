# What took 12.31 seconds?

This explains the actual median sample, `editor-prototype-1`, from the [critical investigation](document-loading-critical-follow-up.md). It is a cold **2,000-paragraph** editor opening, with 100 ms latency, 10 Mbps download, 4 Mbps upload, and 4× CPU slowdown. It is not an unthrottled localhost result or the small-document result. It is still too slow. The small-document editor median in the earlier series was 5.417 seconds.

## Non-overlapping timeline of the recorded run

These intervals cover elapsed time, including overlapping downloads, browser work, and scheduling. Labels describe the work happening in each interval, not exclusive CPU attribution.

| Interval | Duration | What happened |
| --- | ---: | --- |
| 0–0.767 s | 0.767 s | Initial HTML, CSS, and main JavaScript loading. HTML finished at 0.110 s; main JS at 0.767 s. |
| 0.767–1.920 s | 1.153 s | App startup, routing, workspace/space requests, and canonical page resolution. Workspace request began at 1.636 s; canonical page response completed at 1.920 s. |
| 1.920–3.567 s | 1.647 s | Renderer import/setup, associated UI/module work, and editor download initiation. Renderer request ran 2.451–2.630 s; editor request began at 3.250 s. Saved content was not requested until 3.567 s. |
| 3.567–4.079 s | 0.512 s | Saved content request, about 422 KB encoded body. Editor download overlapped this and finished at 3.716 s. |
| 4.079–4.284 s | 0.205 s | Saved content processed and bounded preview appeared. Preview timestamp is a requestAnimationFrame observation, not an exact display scanout measurement. |
| 4.284–12.311 s | 8.027 s | Collaboration startup, full editor population, rendering, and reveal. The final editor paragraph satisfied the visibility check at 12.311 s. |

The app therefore spends approximately **3.57 seconds before requesting saved document content**, then approximately **8.03 more seconds after its preview appears** before the full editor finishes rendering.

The actual main JS request took 0.627 s, the canonical page request 0.156 s, renderer JS 0.179 s, editor JS 0.467 s, and content request 0.512 s. These durations include request waits, server work, and transfer; they overlap and cannot be added as separate phases. This recording does not split backend execution from network latency.

## What the original run proves about CPU work

Long main-thread tasks totaled **9.626 seconds** across the 12.311-second load. **7.108 seconds** of those occurred after the preview appeared, inside the final 8.027-second interval. The last portion contained individual tasks lasting approximately 1.451, 1.518, 2.776, and 0.483 seconds, plus smaller tasks. Long tasks include JavaScript and browser rendering work; this observation alone does not assign each task to a function.

Most of the last eight seconds was therefore occupied by main-thread work. It was not eight seconds of downloading the document. The remaining time must not all be labeled network wait: it also includes short tasks, scheduling, and automation polling.

Code explains the stages in that interval. `DocEditor` creates a Yjs document, opens/replays IndexedDB, then creates the collaboration WebSocket. `Editor` constructs BlockNote/TipTap/ProseMirror. Incoming collaborative content populates the model and node views. The application waits for both editor mounting and authoritative content readiness, then removes the preview and reveals the editor. `doc-document.tsx` mounts the editor under an `invisible`, inert container during this transition; hidden mounting still creates the full document tree.

The original lightweight recording did not include WebSocket frame timestamps or detailed style/layout tracing. Exact individual costs for IndexedDB replay, handshake, model conversion, DOM construction, and reveal cannot be recovered retrospectively from it.

## Additional diagnostic trace: what remains expensive

A subsequent trace of the same prototype combined CPU profiling and Chrome timeline recording, without screenshots or per-frame text extraction. It completed in **33.876 seconds**, with preview at **8.700 seconds** and no captured page errors. The shared host was running unrelated builds. These timings are retained as a separate diagnostic result, not pooled with the original comparison or normalized into its 12.311 seconds.

The relevant renderer thread showed:

- A **5.983-second JavaScript function call** in the collaboration socket's `onmessage` handler, encompassing downstream update processing and editor construction. That is handler execution, not WebSocket transfer time or pure Yjs decoding.
- A **1.698-second style-recalculation event** affecting approximately 10,002 elements, followed by a **0.776-second layout**.
- A later **8.986-second style-recalculation event** affecting approximately 10,015 elements.
- Across the trace, style recalculation totaled about **11.805 seconds**, layout **0.926 seconds**, and paint **0.197 seconds**. Other JavaScript, startup, and scheduling remain. Trace event totals are inclusive; parent task/function totals must not be added to their child work.

This establishes substantial style recalculation in addition to editor JavaScript. It does not yet establish which CSS selectors or visibility/inert transitions caused that work. The approximately 10,000 elements come from rendering the full 2,000-block editor, even though only a small part is on screen. Investigate style invalidation and the preview/editor handoff before claiming a specific CSS fix or using virtualization as a catch-all answer.

For poor connections, transfer and sequential round trips can add further delay before and during these stages. The measured CPU cost does not disappear on a faster connection. Conversely, the 4× CPU slowdown is part of this controlled profile, not a claim that every computer incurs identical CPU time.

[Saved timing and diagnostic evidence](document-loading-timing-breakdown-evidence.json) contains the original resource/long-task observations and the new trace summary. No production code changed for this explanation.
