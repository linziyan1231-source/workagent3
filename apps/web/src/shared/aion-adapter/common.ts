export const ipcBridge = {
  theme: {
    requestCurrent: { invoke: async () => null },
    changed: { on: () => () => undefined },
  },
  fs: {
    listAvailableSkills: { invoke: async () => [] },
    listWorkspaceFiles: { invoke: async () => [] },
  },
};
