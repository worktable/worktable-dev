import { describe, it, expect } from "bun:test";
import { widgetContentUrl, widgetVersionContentUrl } from "./widgets-api";

describe("widgetVersionContentUrl", () => {
  it("builds a version content path under the widget", () => {
    expect(widgetVersionContentUrl("space-1", "chart", "v-123")).toBe(
      "/api/spaces/space-1/widgets/__document/Y2hhcnQ/versions/v-123/content"
    );
  });

  it("keeps nested HTML paths unambiguous across content and version URLs", () => {
    expect(widgetVersionContentUrl("s", "plans/q3-redesign", "v-1")).toBe(
      "/api/spaces/s/widgets/__document/cGxhbnMvcTMtcmVkZXNpZ24/versions/v-1/content"
    );
    expect(widgetContentUrl("s", "plans/q3-redesign")).toBe(
      "/api/spaces/s/widgets/__document/cGxhbnMvcTMtcmVkZXNpZ24/content"
    );
  });

  it("encodes the version id segment", () => {
    expect(widgetVersionContentUrl("s", "w", "v 1/x")).toBe(
      "/api/spaces/s/widgets/__document/dw/versions/v%201%2Fx/content"
    );
  });
});
