export type MermaidPreviewTheme = "light" | "dark";

export interface MermaidValidationResult {
  ok: boolean;
  diagramType: string | null;
  error?: string;
}

export interface MermaidPreviewResult extends MermaidValidationResult {
  svg?: string;
  viewBox?: string | null;
  width?: string | null;
  height?: string | null;
}

type MermaidModule = typeof import("mermaid/dist/mermaid.core.mjs")["default"];

async function ensureDom(): Promise<void> {
  const { JSDOM } = await import("jsdom");
  const dom =
    typeof document !== "undefined" && typeof window !== "undefined"
      ? null
      : new JSDOM("<body></body>", { pretendToBeVisual: true });
  const activeWindow = dom?.window ?? window;
  const g = globalThis as Record<string, unknown>;
  g.window = activeWindow;
  g.document = activeWindow.document;
  g.Element = activeWindow.Element;
  g.HTMLElement = activeWindow.HTMLElement;
  g.SVGElement = activeWindow.SVGElement;
  g.Node = activeWindow.Node;
  g.getComputedStyle = activeWindow.getComputedStyle;
  g.DOMParser = activeWindow.DOMParser;
  g.XMLSerializer = activeWindow.XMLSerializer;
  g.CSSStyleSheet = activeWindow.CSSStyleSheet;
  Object.defineProperty(globalThis, "navigator", {
    value: activeWindow.navigator,
    configurable: true,
  });

  const svgPrototype = activeWindow.SVGElement.prototype as SVGElement & {
    getBBox?: () => { x: number; y: number; width: number; height: number };
    getComputedTextLength?: () => number;
  };

  if (!svgPrototype.getBBox) {
    svgPrototype.getBBox = function () {
      const text = this.textContent || "";
      const width = Math.max(40, text.length * 8);
      return { x: 0, y: 0, width, height: 20 };
    };
  }

  if (!svgPrototype.getComputedTextLength) {
    svgPrototype.getComputedTextLength = function () {
      const text = this.textContent || "";
      return Math.max(40, text.length * 8);
    };
  }
}

function previewConfig(theme: MermaidPreviewTheme) {
  return {
    startOnLoad: false,
    securityLevel: "loose" as const,
    theme: theme === "dark" ? "dark" : "default",
    fontFamily: "General Sans, system-ui, sans-serif",
    flowchart: { htmlLabels: true, curve: "linear" as const },
    sequence: { mirrorActors: true, useMaxWidth: true },
    er: { useMaxWidth: true },
    themeVariables:
      theme === "dark"
        ? {
            primaryTextColor: "#d7dee8",
            primaryColor: "#25303c",
            primaryBorderColor: "#8fb4ff",
            lineColor: "#8190a1",
            secondaryColor: "#18212b",
            tertiaryColor: "#233140",
            background: "#11161d",
            mainBkg: "#25303c",
            textColor: "#d7dee8",
          }
        : {
            primaryTextColor: "#25364a",
            primaryColor: "#f7f9fb",
            primaryBorderColor: "#4f7cff",
            lineColor: "#6a7a8d",
            secondaryColor: "#fbfcfd",
            tertiaryColor: "#eef2f6",
            background: "#ffffff",
            mainBkg: "#f7f9fb",
            textColor: "#25364a",
          },
  };
}

async function loadMermaid(): Promise<MermaidModule> {
  await ensureDom();
  await ensureDomPurify();
  return import("mermaid/dist/mermaid.core.mjs").then((mod) => mod.default);
}

async function ensureDomPurify(): Promise<void> {
  const activeWindow = window as Window & typeof globalThis;
  const domPurifyModule = (await import("dompurify")) as Record<string, any>;
  const domPurifyExport = (domPurifyModule.default ?? domPurifyModule) as Record<string, any>;

  if (typeof domPurifyExport.sanitize !== "function" && typeof domPurifyExport === "function") {
    const instance = domPurifyExport(activeWindow);
    if (instance && typeof instance.sanitize === "function") {
      const instanceRecord = instance as Record<string, unknown>;
      const exportRecord = domPurifyExport as unknown as Record<string, unknown>;
      for (const key of [
        "sanitize",
        "setConfig",
        "clearConfig",
        "isValidAttribute",
        "addHook",
        "removeHook",
        "removeHooks",
        "removeAllHooks",
      ]) {
        const value = instanceRecord[key];
        if (typeof value === "function") {
          exportRecord[key] = value.bind(instance);
        }
      }
    }
  }

  (activeWindow as unknown as Record<string, unknown>).DOMPurify = domPurifyExport;
  (globalThis as Record<string, unknown>).DOMPurify = domPurifyExport;
}

export async function validateMermaid(source: string): Promise<MermaidValidationResult> {
  const trimmed = source.trim();
  if (!trimmed) {
    return { ok: false, diagramType: null, error: "Mermaid source is empty" };
  }

  try {
    const mermaid = await loadMermaid();
    const parseResult = await mermaid.parse(trimmed);
    const diagramType =
      parseResult && typeof parseResult === "object" && "diagramType" in parseResult
        ? String((parseResult as { diagramType?: unknown }).diagramType ?? "") || null
        : null;
    return { ok: true, diagramType };
  } catch (error) {
    return {
      ok: false,
      diagramType: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function previewMermaid(
  source: string,
  theme: MermaidPreviewTheme = "dark",
): Promise<MermaidPreviewResult> {
  const validation = await validateMermaid(source);
  if (!validation.ok) return validation;

  try {
    const mermaid = await loadMermaid();
    mermaid.initialize(previewConfig(theme));
    const renderId = `mcp-preview-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const { svg } = await mermaid.render(renderId, source);
    const viewBox = svg.match(/viewBox="([^"]+)"/)?.[1] ?? null;
    const width = svg.match(/width="([^"]+)"/)?.[1] ?? null;
    const height = svg.match(/height="([^"]+)"/)?.[1] ?? null;

    return {
      ok: true,
      diagramType: validation.diagramType,
      svg,
      viewBox,
      width,
      height,
    };
  } catch (error) {
    return {
      ok: false,
      diagramType: validation.diagramType,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
