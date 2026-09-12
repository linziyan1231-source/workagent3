const baseKeys = new Set([
  "APPDATA",
  "COMSPEC",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "USERPROFILE",
  "USERNAME",
  "WINDIR",
]);

export function nativeEngineEnvironment(
  source: NodeJS.ProcessEnv,
  privateHomeKey: "CODEX_HOME" | "KIMI_CODE_HOME" | "ACP_HOME",
): NodeJS.ProcessEnv {
  const allowed = new Set(baseKeys);
  allowed.add(privateHomeKey);
  return Object.fromEntries(
    Object.entries(source).filter(([key, value]) => {
      if (value === undefined) return false;
      return allowed.has(key.toUpperCase());
    }),
  );
}
