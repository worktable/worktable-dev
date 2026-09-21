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
