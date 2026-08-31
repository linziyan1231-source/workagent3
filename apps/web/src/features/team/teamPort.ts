import {
  engineIdSchema,
  teamEventListSchema,
  teamEventSchema,
  teamListSchema,
  teamMailboxMessageListSchema,
  teamMailboxMessageSchema,
  teamSchema,
  teamTaskListSchema,
  teamTaskSchema,
  type EngineId,
  type Team,
  type TeamCreate,
  type TeamEvent,
  type TeamMailboxMessage,
  type TeamTask,
} from "@workagent/contracts";
import { requestJson } from "../../shared/api/http.js";

const base = "/api/runtime/v1/teams";
const path = (teamId: string) => `${base}/${encodeURIComponent(teamId)}`;

export type TeamPort = {
  list(): Promise<Team[]>;
  get(teamId: string): Promise<Team>;
  create(input: TeamCreate): Promise<Team>;
  rename(team: Team, name: string): Promise<Team>;
  remove(teamId: string): Promise<void>;
  addMember(
    teamId: string,
    input: { name: string; engine: EngineId; presetId: string },
  ): Promise<Team>;
  updateMember(
    teamId: string,
    memberId: string,
    input: { name?: string; engine?: EngineId; presetId?: string },
  ): Promise<Team>;
  removeMember(teamId: string, memberId: string): Promise<Team>;
  tasks(teamId: string): Promise<TeamTask[]>;
  queueTask(
    teamId: string,
    input: { memberId: string; title: string; input: string },
  ): Promise<TeamTask>;
  cancelTask(teamId: string, taskId: string): Promise<TeamTask>;
  messages(teamId: string, memberId?: string): Promise<TeamMailboxMessage[]>;
  sendMessage(
    teamId: string,
    input: {
      fromMemberId: string | null;
      toMemberId: string | null;
      body: string;
    },
  ): Promise<TeamMailboxMessage>;
  events(teamId: string, after?: number): Promise<TeamEvent[]>;
  subscribe(teamId: string, listener: (event: TeamEvent) => void): () => void;
};

export const teamPort: TeamPort = {
  async list() {
    return teamListSchema.parse(await requestJson<unknown>(base));
  },
  async get(teamId) {
    return teamSchema.parse(await requestJson<unknown>(path(teamId)));
  },
  async create(input) {
    return teamSchema.parse(
      await requestJson<unknown>(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
  },
  async rename(team, name) {
    return teamSchema.parse(
      await requestJson<unknown>(path(team.id), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: team.version, name }),
      }),
    );
  },
  async remove(teamId) {
    await requestJson(path(teamId), { method: "DELETE" });
  },
  async addMember(teamId, input) {
    engineIdSchema.parse(input.engine);
    return teamSchema.parse(
      await requestJson<unknown>(`${path(teamId)}/members`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
  },
  async updateMember(teamId, memberId, input) {
    if (input.engine !== undefined) engineIdSchema.parse(input.engine);
    return teamSchema.parse(
      await requestJson<unknown>(
        `${path(teamId)}/members/${encodeURIComponent(memberId)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      ),
    );
  },
  async removeMember(teamId, memberId) {
    return teamSchema.parse(
      await requestJson<unknown>(
        `${path(teamId)}/members/${encodeURIComponent(memberId)}`,
        { method: "DELETE" },
      ),
    );
  },
  async tasks(teamId) {
    return teamTaskListSchema.parse(
      await requestJson<unknown>(`${path(teamId)}/tasks`),
    );
  },
  async queueTask(teamId, input) {
    return teamTaskSchema.parse(
      await requestJson<unknown>(`${path(teamId)}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
  },
  async cancelTask(teamId, taskId) {
    return teamTaskSchema.parse(
      await requestJson<unknown>(
        `${path(teamId)}/tasks/${encodeURIComponent(taskId)}/cancel`,
        { method: "POST" },
      ),
    );
  },
  async messages(teamId, memberId) {
    const query =
      memberId === undefined ? "" : `?memberId=${encodeURIComponent(memberId)}`;
    return teamMailboxMessageListSchema.parse(
      await requestJson<unknown>(`${path(teamId)}/messages${query}`),
    );
  },
  async sendMessage(teamId, input) {
    return teamMailboxMessageSchema.parse(
      await requestJson<unknown>(`${path(teamId)}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
  },
  async events(teamId, after = 0) {
    return teamEventListSchema.parse(
      await requestJson<unknown>(`${path(teamId)}/events?after=${after}`),
    );
  },
  subscribe(teamId, listener) {
    const source = new EventSource(`${path(teamId)}/events`);
    const eventTypes: TeamEvent["type"][] = [
      "team.updated",
      "task.queued",
      "task.started",
      "task.completed",
      "task.failed",
      "task.cancelled",
      "mail.received",
    ];
    const receive = (event: MessageEvent<string>) =>
      listener(teamEventSchema.parse(JSON.parse(event.data)));
    for (const type of eventTypes)
      source.addEventListener(type, receive as EventListener);
    return () => source.close();
  },
};
