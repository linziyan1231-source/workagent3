import type { Context } from "@deepseek-ai/cordis";
import type { ProjectionDefinition } from "@deepseek-ai/dsh-session-projection";
import { z } from "zod";
import type {} from "./native-session-log.js";

const message = z.object({
  id: z.string(),
  sessionId: z.string(),
  role: z.enum(["user", "assistant"]),
  text: z.string(),
  createdAt: z.string(),
  nativeTurnId: z.string().optional(),
});
const fact = z.record(z.string(), z.json());
const stateSchema = z.object({
  messages: z.array(message),
  lastEvent: fact.optional(),
  draft: z.string(),
  progress: z.string(),
  activeTool: z.boolean(),
  metadata: fact,
  activity: z.object({
    state: z.enum(["idle", "running", "retrying"]),
    message: z.string().optional(),
  }),
  tools: z.record(z.string(), fact),
  capabilities: fact,
});
export type NativeSessionProjection = z.infer<typeof stateSchema>;
// DSH's declared Zod dependency and the bundle can resolve different compatible
// 4.x minor copies under pnpm. Their public parse contract agrees, while Zod's
// nominal internal version literals do not. Keep the bridge at this schema edge.
const projectionSchema =
  stateSchema as unknown as ProjectionDefinition<"nativeSession">["stateSchema"];

declare module "@deepseek-ai/dsh-session-projection" {
  interface SessionProjectionMap {
    nativeSession: NativeSessionProjection;
  }
  interface SessionProjectionStateMap {
    nativeSession: NativeSessionProjection;
  }
}

export const nativeSessionProjection: ProjectionDefinition<"nativeSession"> = {
  key: "nativeSession",
  stateVersion: 1,
  stateSchema: projectionSchema,
  init: () => ({
    messages: [],
    draft: "",
    progress: "",
    activeTool: false,
    metadata: {},
    activity: { state: "idle" },
    tools: {},
    capabilities: {},
  }),
  apply(state, event) {
    if (event.type === "workagent/native/message")
      return { ...state, messages: [...state.messages, event.data] };
    if (event.type === "turn/start")
      return {
        ...state,
        draft: "",
        progress: "",
        activity: { state: "running" },
      };
    if (event.type === "turn/end")
      return {
        ...state,
        draft: "",
        progress: "",
        activeTool: false,
        activity: {
          state: "idle",
          ...(event.data.reason.kind === "interrupted"
            ? { message: "native_turn_interrupted" }
            : event.data.reason.kind === "error"
              ? { message: event.data.reason.error.message }
              : {}),
        },
      };
    if (event.type !== "workagent/native/event") return state;
    const data = event.data;
    const next = { ...state, lastEvent: data };
    if (data.type === "assistant.delta" && typeof data.delta === "string")
      next.draft += data.delta;
    if (
      data.type === "assistant.completed" ||
      ["turn.completed", "turn.cancelled", "turn.failed"].includes(data.type)
    )
      next.draft = "";
    if (data.type === "session.metadata") next.metadata = data;
    if (data.type === "turn.retrying")
      next.activity = {
        state: "retrying",
        ...(typeof data.message === "string" ? { message: data.message } : {}),
      };
    if (data.type.startsWith("tool.") && typeof data.toolCallId === "string")
      next.tools = {
        ...state.tools,
        [data.toolCallId]: { ...state.tools[data.toolCallId], ...data },
      };
    if (data.type.startsWith("tool."))
      next.activeTool = Object.values(next.tools).some(
        (tool) => tool.type !== "tool.completed" && tool.turnId === data.turnId,
      );
    if (data.type.startsWith("tool."))
      next.progress = next.activeTool ? "正在执行工具…" : "";
    if (data.type === "session.capabilities") next.capabilities = data;
    return next;
  },
  wire: { viewSchema: projectionSchema, view: (state) => state },
};

export function registerNativeSessionProjection(ctx: Context): () => void {
  return ctx.sessionProjections.register({
    ...nativeSessionProjection,
    wire: nativeSessionProjection.wire!,
  });
}
