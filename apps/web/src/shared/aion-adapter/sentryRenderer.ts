type Scope = {
  setTag: (_key: string, _value: string) => void;
  setUser: (_user: { email: string }) => void;
};

const scope: Scope = {
  setTag: () => undefined,
  setUser: () => undefined,
};

export function withScope(callback: (value: Scope) => void) {
  callback(scope);
}

export function captureEvent() {
  return undefined;
}

export function getClient() {
  return undefined;
}
