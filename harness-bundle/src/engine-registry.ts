export const ENGINE_CAPABILITIES = {
  harness: {
    approval: true,
    resume: true,
    steer: true,
    toolEvents: true,
    usage: true,
  },
  codex: {
    approval: true,
    resume: true,
    steer: true,
    toolEvents: true,
    usage: false,
  },
  kimi: {
    approval: true,
    resume: true,
    steer: true,
    toolEvents: true,
    usage: false,
  },
} as const;
