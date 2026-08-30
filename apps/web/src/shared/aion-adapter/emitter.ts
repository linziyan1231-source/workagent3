import { useEffect } from "react";

export type ReplyQuote = { content: string };
export const emitter = { emit: (_event: string, ..._args: unknown[]) => undefined };
export function useAddEventListener(
  _event: string,
  _listener: (...args: any[]) => void,
  dependencies: readonly unknown[],
) {
  useEffect(() => undefined, dependencies);
}
