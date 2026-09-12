import type { PendingInteraction } from "./approval-bridge.js";
import type { NativeApprovalDecision } from "./engines/types.js";
import type { Session } from "@deepseek-ai/dsh-session";
import type {
  ModelSelection,
  QueueAction,
  SessionModels,
} from "@deepseek-ai/dsh-host-apiproxy";
import type { RuntimeSession } from "@workagent/contracts";
import type { QueuedInput } from "./session-index.js";
import type { StoredMessage } from "./message-store.js";

/** In-process employee-owned entry. All execution still goes through RuntimeController admission. */
export interface NativeSessionPort {
  owns(id: string): boolean;
  approvals(): PendingInteraction[];
  respondApproval(
    sessionId: string,
    approvalId: string,
    decision: NativeApprovalDecision,
  ): boolean;
  list(): Array<RuntimeSession & { workspacePath: string }>;
  session(id: string): Session | undefined;
  messages(id: string): StoredMessage[];
  queue(id: string): QueuedInput[];
  prompt(
    id: string,
    content: string,
    mode: "queue" | "steer",
    messageId?: string,
  ): Promise<void>;
  cancel(id: string): Promise<void>;
  updateQueue(id: string, itemId: string, action: QueueAction): Promise<void>;
  fork(id: string, messageId?: string): Promise<RuntimeSession>;
  rename(id: string, title: string): string;
  models(id: string): Promise<SessionModels>;
  selectModel(id: string, selection: ModelSelection): Promise<ModelSelection>;
}

declare module "@deepseek-ai/cordis" {
  interface Context {
    workagentSessions: NativeSessionPort;
  }
}
