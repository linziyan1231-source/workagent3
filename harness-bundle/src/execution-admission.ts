/** Busy is an admission result: no engine request or quota reservation occurred. */
export class SessionBusyError extends Error {
  constructor(readonly sessionId: string) {
    super("session_busy");
    this.name = "SessionBusyError";
  }
}

export type ExecutionAdmission = { release(): void };
