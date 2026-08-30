export const ENGINE_CAPABILITIES = {
  harness: {
    approval: true,
    resume: true,
    steer: false,
    toolEvents: true,
    usage: true,
  },
  codex: {
    approval: false,
    resume: true,
    steer: false,
    toolEvents: true,
    usage: false,
  },
  kimi: {
    approval: false,
    resume: true,
    steer: false,
    toolEvents: true,
    usage: false,
  },
} as const;
