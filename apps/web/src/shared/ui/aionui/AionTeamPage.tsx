/**
 * Web transport adaptation of the latest WorkAgent2 Renderer TeamPage.
 * Its agent tabs, leader treatment, workspace split and SendBox hierarchy are
 * retained; Electron team/session hooks are replaced by TeamPort HTTP/SSE.
 */
import type {
  EngineId,
  Team,
  TeamMailboxMessage,
  TeamMember,
  TeamTask,
} from "@workagent/contracts";
import {
  Button,
  Input,
  Message,
  Modal,
  Select,
  Spin,
  Tabs,
} from "@arco-design/web-react";
import {
  CloseSmall,
  Peoples,
  Plus,
  Robot,
  Send,
  PauseOne,
} from "@icon-park/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { teamPort, type TeamPort } from "../../../features/team/teamPort.js";
import { AionSendBox } from "./AionSendBox.js";

type Props = { port?: TeamPort; presetId: string };

const statusLabel: Record<TeamTask["status"], string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
};

function LeaderCrown() {
  return (
    <svg
      width="15"
      height="15"
      viewBox="0 0 16 16"
      fill="none"
      aria-label="Team leader"
    >
      <path
        d="M2.3 13L1.2 4.7L4.8 6.5L8 2.1L11.2 6.5L14.8 4.7L13.7 13H2.3Z"
        strokeWidth="1.25"
        strokeLinejoin="round"
        style={{ fill: "var(--warning)", stroke: "var(--text-primary)" }}
      />
      <path
        d="M5 10.1H11"
        strokeWidth="1.1"
        strokeLinecap="round"
        style={{ stroke: "var(--text-primary)" }}
      />
    </svg>
  );
}

function AgentIdentity({
  member,
  large = false,
}: {
  member: TeamMember;
  large?: boolean;
}) {
  return (
    <div className="flex items-center gap-8px min-w-0">
      <span
        className={`${large ? "w-48px h-48px rd-8px" : "w-16px h-16px rd-2px"} flex items-center justify-center bg-fill-2 shrink-0`}
      >
        <Robot theme="outline" size={large ? 24 : 12} />
      </span>
      <span className="min-w-0 truncate text-t-primary">{member.name}</span>
      {member.role === "lead" && <LeaderCrown />}
    </div>
  );
}

export function AionTeamPage({ port = teamPort, presetId }: Props) {
  const { teamId = "" } = useParams();
  const navigate = useNavigate();
  const [team, setTeam] = useState<Team>();
  const [tasks, setTasks] = useState<TeamTask[]>([]);
  const [mail, setMail] = useState<TeamMailboxMessage[]>([]);
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [loading, setLoading] = useState(true);
  const [addVisible, setAddVisible] = useState(false);
  const [memberName, setMemberName] = useState("");
  const [memberEngine, setMemberEngine] = useState<EngineId>("harness");
  const [mailText, setMailText] = useState("");

  const refresh = useCallback(async () => {
    const [nextTeam, nextTasks, nextMail] = await Promise.all([
      port.get(teamId),
      port.tasks(teamId),
      port.messages(teamId),
    ]);
    setTeam(nextTeam);
    setTasks(nextTasks);
    setMail(nextMail);
    setSelectedMemberId((current) =>
      nextTeam.members.some((member) => member.id === current)
        ? current
        : (nextTeam.members[0]?.id ?? ""),
    );
    setLoading(false);
  }, [port, teamId]);

  useEffect(() => {
    setLoading(true);
    void refresh().catch(() => {
      Message.error("Unable to load team");
      void navigate("/");
    });
  }, [navigate, refresh]);

  useEffect(() => {
    if (!teamId) return;
    return port.subscribe(teamId, () => void refresh());
  }, [port, refresh, teamId]);

  const selectedMember = team?.members.find(
    (member) => member.id === selectedMemberId,
  );
  const selectedTasks = useMemo(
    () => tasks.filter((task) => task.memberId === selectedMemberId),
    [selectedMemberId, tasks],
  );

  const queueTask = async (value: string) => {
    if (!selectedMember || !value.trim()) return;
    await port.queueTask(teamId, {
      memberId: selectedMember.id,
      title: value.trim().slice(0, 80),
      input: value.trim(),
    });
    await refresh();
  };

  const updateMemberName = async (member: TeamMember, name: string) => {
    if (!name.trim() || !team) return;
    await port.updateMember(team.id, member.id, { name: name.trim() });
    await refresh();
  };

  const removeMember = (member: TeamMember) => {
    if (member.role === "lead") return;
    Modal.confirm({
      title: "Remove teammate?",
      content: `${member.name} will be removed from this team.`,
      okText: "Remove",
      cancelText: "Cancel",
      okButtonProps: { status: "warning" },
      alignCenter: true,
      style: { borderRadius: 12 },
      onOk: async () => {
        await port.removeMember(teamId, member.id);
        await refresh();
      },
    });
  };

  const createMember = async () => {
    if (!memberName.trim()) return;
    await port.addMember(teamId, {
      name: memberName.trim(),
      engine: memberEngine,
      presetId,
    });
    setMemberName("");
    setAddVisible(false);
    await refresh();
  };

  const sendMail = async () => {
    if (!mailText.trim()) return;
    await port.sendMessage(teamId, {
      fromMemberId: null,
      toMemberId: selectedMemberId || null,
      body: mailText.trim(),
    });
    setMailText("");
    await refresh();
  };

  if (loading || !team || !selectedMember) {
    return (
      <div className="size-full flex items-center justify-center bg-bg-1">
        <Spin loading />
      </div>
    );
  }

  return (
    <main className="aion-team-page size-full min-w-0 min-h-0 flex flex-col bg-bg-1">
      <header className="h-48px px-16px shrink-0 flex items-center border-b border-solid border-[color:var(--border-base)] bg-bg-2">
        <Peoples
          theme="outline"
          size="18"
          fill="currentColor"
          className="text-t-secondary"
        />
        <span className="ml-8px text-14px font-600 text-t-primary truncate">
          {team.name}
        </span>
        <span className="ml-8px text-12px text-t-tertiary">
          {team.members.length} agents
        </span>
        <Button
          type="text"
          size="small"
          className="ml-auto !rd-8px"
          icon={<Plus theme="outline" size="14" />}
          onClick={() => setAddVisible(true)}
        >
          Add teammate
        </Button>
      </header>

      <div
        data-testid="team-tab-bar"
        className="relative shrink-0 bg-bg-2 min-h-40px"
      >
        <div className="flex items-center h-40px w-full overflow-x-auto border-b border-solid border-[color:var(--border-base)]">
          {team.members.map((member) => {
            const active = member.id === selectedMemberId;
            return (
              <div
                key={member.id}
                className={`relative group flex items-center gap-8px px-12px h-full max-w-240px cursor-pointer transition-all duration-200 shrink-0 border-r border-solid border-[color:var(--border-base)] ${active ? "bg-[color:var(--color-primary-1)] border-t-2 border-t-solid border-t-[color:var(--color-primary-6)]" : "bg-bg-2 text-t-tertiary hover:bg-fill-2"}`}
                onClick={() => setSelectedMemberId(member.id)}
                onDoubleClick={() => {
                  const name = window.prompt("Rename teammate", member.name);
                  if (name) void updateMemberName(member, name);
                }}
              >
                <AgentIdentity member={member} />
                <span
                  className={`size-7px rounded-full ${member.status === "running" ? "bg-primary-6" : member.status === "error" ? "bg-danger-6" : "bg-success-6"}`}
                />
                {member.role !== "lead" && (
                  <CloseSmall
                    size="14"
                    className="opacity-0 group-hover:opacity-60 hover:!opacity-100"
                    onClick={(event) => {
                      event.stopPropagation();
                      removeMember(member);
                    }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="flex-1 min-h-0 grid grid-cols-[minmax(0,1fr)_320px] max-[900px]:grid-cols-1">
        <section className="min-w-0 min-h-0 flex flex-col border-r border-solid border-[color:var(--border-base)]">
          <div className="h-40px px-12px flex items-center justify-between border-b border-solid border-[color:var(--border-base)] bg-bg-2">
            <AgentIdentity member={selectedMember} />
            <span className="text-12px text-t-tertiary capitalize">
              {selectedMember.engine}
            </span>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-24px py-20px">
            {selectedTasks.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center gap-20px px-24px text-center">
                <AgentIdentity member={selectedMember} large />
                <div className="flex flex-col gap-6px max-w-360px">
                  <span className="text-16px font-semibold text-t-primary">
                    {selectedMember.name}
                  </span>
                  <span className="text-13px text-t-secondary">
                    {selectedMember.role === "lead"
                      ? "Describe your goal and I'll get the team working on it"
                      : "Assign a task to this teammate"}
                  </span>
                </div>
              </div>
            ) : (
              <div className="max-w-760px mx-auto flex flex-col gap-12px">
                {selectedTasks.map((task) => (
                  <article
                    key={task.id}
                    className="rd-12px border border-solid border-[color:var(--border-base)] bg-bg-2 px-14px py-12px"
                  >
                    <div className="flex items-center gap-8px">
                      <span className="font-500 text-13px text-t-primary truncate">
                        {task.title}
                      </span>
                      <span
                        className={`ml-auto text-11px px-7px py-2px rd-10px ${task.status === "failed" ? "text-danger-6 bg-danger-1" : task.status === "succeeded" ? "text-success-6 bg-success-1" : "text-primary-6 bg-primary-1"}`}
                      >
                        {statusLabel[task.status]}
                      </span>
                      {(task.status === "queued" ||
                        task.status === "running") && (
                        <Button
                          type="text"
                          size="mini"
                          icon={<PauseOne size="12" />}
                          onClick={() => void port.cancelTask(teamId, task.id)}
                        />
                      )}
                    </div>
                    <p className="mt-8px mb-0 whitespace-pre-wrap text-13px leading-20px text-t-secondary">
                      {task.input}
                    </p>
                    {(task.result || task.error) && (
                      <div className="mt-10px pt-10px border-t border-solid border-[color:var(--border-base)] whitespace-pre-wrap text-13px leading-20px text-t-primary">
                        {task.result ?? task.error}
                      </div>
                    )}
                  </article>
                ))}
              </div>
            )}
          </div>
          <div className="aion-composer chat-surface-container px-16px pb-16px pt-8px">
            <AionSendBox
              loading={selectedMember.status === "running"}
              onSend={queueTask}
              onStop={async () => {
                const running = selectedTasks.find(
                  (task) =>
                    task.status === "running" || task.status === "queued",
                );
                if (running) await port.cancelTask(teamId, running.id);
              }}
              onAttach={() =>
                Message.info("Team tasks use the shared project workspace")
              }
            />
          </div>
        </section>

        <aside className="min-h-0 bg-bg-2 max-[900px]:hidden">
          <Tabs defaultActiveTab="tasks" className="size-full flex flex-col">
            <Tabs.TabPane key="tasks" title="Task board">
              <div className="px-12px pb-12px flex flex-col gap-8px overflow-y-auto">
                {tasks.map((task) => {
                  const member = team.members.find(
                    (item) => item.id === task.memberId,
                  );
                  return (
                    <div
                      key={task.id}
                      className="rd-10px bg-fill-1 border border-solid border-[color:var(--border-base)] px-12px py-10px cursor-pointer hover:bg-fill-2"
                      onClick={() => setSelectedMemberId(task.memberId)}
                    >
                      <div className="text-13px font-500 text-t-primary truncate">
                        {task.title}
                      </div>
                      <div className="mt-6px flex items-center text-11px text-t-tertiary">
                        <span className="truncate">{member?.name}</span>
                        <span className="ml-auto">
                          {statusLabel[task.status]}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </Tabs.TabPane>
            <Tabs.TabPane
              key="mail"
              title={`Mailbox${mail.length ? ` (${mail.length})` : ""}`}
            >
              <div className="h-full px-12px pb-12px flex flex-col gap-8px">
                <div className="flex-1 min-h-0 overflow-y-auto flex flex-col gap-8px">
                  {mail.map((item) => (
                    <div
                      key={item.id}
                      className="rd-10px bg-fill-1 px-12px py-10px text-12px text-t-secondary whitespace-pre-wrap"
                    >
                      {item.body}
                    </div>
                  ))}
                </div>
                <div className="flex gap-6px">
                  <Input
                    value={mailText}
                    onChange={setMailText}
                    placeholder={`Message ${selectedMember.name}`}
                    onPressEnter={() => void sendMail()}
                  />
                  <Button
                    type="primary"
                    icon={<Send size="14" />}
                    disabled={!mailText.trim()}
                    onClick={() => void sendMail()}
                  />
                </div>
              </div>
            </Tabs.TabPane>
          </Tabs>
        </aside>
      </div>

      <Modal
        title="Add teammate"
        visible={addVisible}
        onOk={() => void createMember()}
        onCancel={() => setAddVisible(false)}
        okText="Add"
        cancelText="Cancel"
        okButtonProps={{ disabled: !memberName.trim() }}
        alignCenter
        style={{ borderRadius: 12 }}
      >
        <div className="flex flex-col gap-12px">
          <Input
            autoFocus
            value={memberName}
            onChange={setMemberName}
            placeholder="Teammate name"
          />
          <Select value={memberEngine} onChange={setMemberEngine}>
            <Select.Option value="harness">Harness</Select.Option>
            <Select.Option value="codex">Codex</Select.Option>
            <Select.Option value="kimi">Kimi</Select.Option>
          </Select>
        </div>
      </Modal>
    </main>
  );
}
