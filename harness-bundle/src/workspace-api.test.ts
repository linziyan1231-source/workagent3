import { describe, expect, it } from "vitest";
import { workspaceContentHeaders } from "./workspace-api.js";

describe("Workspace content response", () => {
  it("allows authenticated same-origin PDF framing only when preview is explicit", () => {
    expect(workspaceContentHeaders("reports/final.pdf", 4, true)).toEqual({
      "cache-control": "no-store",
      "content-disposition": "inline; filename*=UTF-8''final.pdf",
      "content-length": 4,
      "content-security-policy":
        "default-src 'none'; frame-ancestors 'self'; base-uri 'none'",
      "content-type": "application/pdf",
    });
  });

  it("keeps unknown and non-preview content download-only", () => {
    expect(
      workspaceContentHeaders("reports/active.html", 7, true),
    ).toMatchObject({
      "content-disposition": "attachment; filename*=UTF-8''active.html",
      "content-type": "application/octet-stream",
    });
    expect(
      workspaceContentHeaders("reports/final.pdf", 4, false),
    ).toMatchObject({
      "content-disposition": "attachment; filename*=UTF-8''final.pdf",
      "content-type": "application/octet-stream",
    });
  });

  it("serves raster image previews inline with their real media type", () => {
    expect(workspaceContentHeaders("images/chart.png", 42, true)).toMatchObject(
      {
        "content-disposition": "inline; filename*=UTF-8''chart.png",
        "content-type": "image/png",
      },
    );
  });
});
