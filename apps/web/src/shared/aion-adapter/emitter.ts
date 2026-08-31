import { useEffect, type DependencyList } from "react";

export type ReplyQuote = {
  messageId: string;
  content: string;
  position: "left" | "right" | "center" | "pop";
};

type Listener = (...args: any[]) => void;
const listeners = new Map<string, Set<Listener>>();

export const emitter = {
  emit(event: string, ...args: any[]) {
    for (const listener of listeners.get(event) ?? []) listener(...args);
  },
  on(event: string, listener: Listener) {
    const group = listeners.get(event) ?? new Set<Listener>();
    group.add(listener);
    listeners.set(event, group);
    return emitter;
  },
  off(event: string, listener: Listener) {
    listeners.get(event)?.delete(listener);
    return emitter;
  },
};

export function addEventListener(event: string, listener: Listener) {
  emitter.on(event, listener);
  return () => {
    emitter.off(event, listener);
  };
}

export function useAddEventListener(
  event: string,
  listener: Listener,
  dependencies: DependencyList = [],
) {
  useEffect(() => addEventListener(event, listener), dependencies);
}
