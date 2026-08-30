export const theme = { Color: { PrimaryColor: "#165dff" } };

/** Browser-safe stand-in for Electron-only providers still declared by the
 * upstream bridge. WorkAgent3-owned features use HTTP/SSE adapters instead. */
export const bridge = {
  buildProvider<TResult, TPayload>(_channel: string) {
    return {
      invoke: async (_payload?: TPayload): Promise<TResult> =>
        undefined as TResult,
    };
  },
  buildEmitter<TPayload>(_channel: string) {
    return {
      emit: async (_payload: TPayload): Promise<void> => undefined,
      on: (_listener: (payload: TPayload) => void) => () => undefined,
    };
  },
};

export const storage = {
  buildStorage<TRecord extends object>(namespace: string) {
    const keyFor = (key: keyof TRecord) => `${namespace}:${String(key)}`;
    return {
      async get<TKey extends keyof TRecord>(key: TKey): Promise<TRecord[TKey] | undefined> {
        const value = localStorage.getItem(keyFor(key));
        return value === null ? undefined : (JSON.parse(value) as TRecord[TKey]);
      },
      async set<TKey extends keyof TRecord>(key: TKey, value: TRecord[TKey]): Promise<void> {
        localStorage.setItem(keyFor(key), JSON.stringify(value));
      },
      async remove<TKey extends keyof TRecord>(key: TKey): Promise<void> {
        localStorage.removeItem(keyFor(key));
      },
      interceptor() {},
    };
  },
};
