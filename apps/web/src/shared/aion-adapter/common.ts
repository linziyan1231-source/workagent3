export const ipcBridge = {
  theme: {
    requestCurrent: { invoke: async () => null },
    setActive: { invoke: async () => undefined },
    changed: { on: () => () => undefined },
  },
  fs: {
    listAvailableSkills: { invoke: async () => [] },
    listWorkspaceFiles: { invoke: async () => [] },
  },
  extensions: {
    getMcpServers: { invoke: async () => [] },
  },
  application: {
    systemInfo: {
      invoke: async () => ({ workDir: "", cacheDir: "", logDir: "" }),
    },
    getStartOnBootStatus: { invoke: async () => ({ success: true }) },
    getGpuStatus: { invoke: async () => ({ success: true }) },
    setGpuOverride: { invoke: async () => ({ success: false }) },
    setStartOnBoot: { invoke: async () => ({ success: false }) },
    updateSystemInfo: { invoke: async () => undefined },
    restart: { invoke: async () => ({ success: false }) },
    isDevToolsOpened: { invoke: async () => false },
    openDevTools: { invoke: async () => false },
    getCdpStatus: { invoke: async () => ({ success: false }) },
    updateCdpConfig: { invoke: async () => ({ success: false }) },
    devToolsStateChanged: { on: () => () => undefined },
    logStream: { on: () => () => undefined },
    writeRendererLog: { invoke: async () => undefined },
  },
  systemSettings: {
    getCloseToTray: { invoke: async () => false },
    setCloseToTray: { invoke: async () => undefined },
  },
  portal: {
    listAllSharedProjects: { invoke: async () => ({ projects: [] }) },
    listAllSharedConversations: { invoke: async () => ({ conversations: [] }) },
    setSharedProjectHidden: { invoke: async () => undefined },
    setSharedConversationHidden: { invoke: async () => undefined },
    updateProfile: { invoke: async () => ({ profile: {} }) },
    restartService: { invoke: async () => ({ reconnect_after_ms: 2000 }) },
    listSharedInvites: { invoke: async () => ({ invites: [] }) },
    acceptSharedInvite: { invoke: async () => ({ success: false }) },
    declineSharedInvite: { invoke: async () => ({ success: false }) },
  },
  conversation: {
    get: {
      invoke: async () => ({
        id: "workagent",
        name: "WorkAgent",
        title: "WorkAgent",
      }),
    },
    listChanged: { emit: () => undefined, on: () => () => undefined },
    responseStream: { on: () => () => undefined },
    turnCompleted: { on: () => () => undefined },
  },
  team: {
    get: { invoke: async () => null },
  },
  task: {
    stopAll: { invoke: async () => ({ success: false }) },
  },
  database: {
    conversations: { invoke: async () => [] },
  },
  windowControls: {
    getState: { invoke: async () => ({ is_maximized: false }) },
    stateChanged: { on: () => () => undefined },
    minimize: { invoke: async () => undefined },
    maximize: { invoke: async () => undefined },
    unmaximize: { invoke: async () => undefined },
    close: { invoke: async () => undefined },
  },
  shell: {
    openExternal: {
      invoke: async (url: string) => {
        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
  },
};
