declare module "jsdom" {
  export interface JSDOMOptions {
    pretendToBeVisual?: boolean;
  }

  export class JSDOM {
    constructor(html?: string, options?: JSDOMOptions);
    window: Window & typeof globalThis;
  }
}

declare module "mermaid/dist/mermaid.core.mjs" {
  export interface MermaidParseResult {
    diagramType?: string;
    config?: Record<string, unknown>;
  }

  export interface MermaidRenderResult {
    svg: string;
  }

  export interface MermaidModule {
    parse(source: string): Promise<MermaidParseResult>;
    initialize(config: unknown): void;
    render(id: string, source: string): Promise<MermaidRenderResult>;
  }

  const mermaid: MermaidModule;
  export default mermaid;
}

declare module "*.woff" {
  const path: string
  export default path
}
declare module "*.wasm" {
  const path: string
  export default path
}
declare module "@quickdrawjs/core/geometry" {
  export function geoPolygon(geo: string, w: number, h: number): number[]
  export function ellipsePolygon(w: number, h: number, n?: number): number[]
  export function wobblePolyline(
    points: number[],
    seed: string,
    options: { step: number; amp: number; closed?: boolean }
  ): number[]
  export function traceSmooth(
    path: {
      moveTo(x: number, y: number): void
      lineTo(x: number, y: number): void
      quadraticCurveTo(x: number, y: number, nx: number, ny: number): void
      closePath(): void
    },
    points: number[],
    closed?: boolean
  ): void
}
declare module "@quickdrawjs/core/freehand" {
  export function strokeOutline(
    points: number[],
    options: { size: number; simulate: boolean }
  ): number[]
}

declare module "*.woff2" { const path: string; export default path }
declare module "*.bundle.js" { const path: string; export default path }
