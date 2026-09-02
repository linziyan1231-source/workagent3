// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it } from "vitest";
import { usePreviewContext } from "@renderer/pages/conversation/Preview/context/PreviewContext";
import { AionRendererProvider } from "./AionRendererProvider.js";

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function PreviewConsumer() {
  const { isOpen } = usePreviewContext();
  return <span>preview:{String(isOpen)}</span>;
}

describe("AionRendererProvider", () => {
  it("preserves the formal Renderer PreviewProvider above layout consumers", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <AionRendererProvider>
          <PreviewConsumer />
        </AionRendererProvider>,
      ),
    );
    expect(container.textContent).toBe("preview:false");
    await act(async () => root.unmount());
    container.remove();
  });
});
