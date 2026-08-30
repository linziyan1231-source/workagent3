import type { ComponentType } from "react";

declare const RendererGuidComponent: ComponentType<any>;

export function useInputFocusRing(): {
  activeBorderColor: string;
  inactiveBorderColor: string;
  activeShadow: string;
};

export default RendererGuidComponent;
