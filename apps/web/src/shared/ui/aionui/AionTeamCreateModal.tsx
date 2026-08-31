/** Direct transport adaptation of WorkAgent2 Renderer TeamCreateModal. */
import type { EngineId, Team } from "@workagent/contracts";
import { Button, Form, Input, Message, Modal } from "@arco-design/web-react";
import type { RefInputType } from "@arco-design/web-react/es/Input/interface";
import { Close } from "@icon-park/react";
import { useEffect, useRef, useState } from "react";
import type { TeamPort } from "../../../features/team/teamPort.js";

const engines: { id: EngineId; name: string; description: string }[] = [
  { id: "harness", name: "Harness", description: "WorkAgent built-in agent" },
  { id: "codex", name: "Codex", description: "OpenAI Codex runtime" },
  { id: "kimi", name: "Kimi", description: "Kimi agent runtime" },
];

type Props = {
  visible: boolean;
  workspaceId: string;
  presetId: string;
  port: TeamPort;
  onClose: () => void;
  onCreated: (team: Team) => void;
};

export function AionTeamCreateModal(props: Props) {
  const [name, setName] = useState("");
  const [leaderName, setLeaderName] = useState("Leader");
  const [engine, setEngine] = useState<EngineId>("harness");
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<RefInputType>(null);

  useEffect(() => {
    if (props.visible) setTimeout(() => inputRef.current?.focus(), 50);
  }, [props.visible]);

  const close = () => {
    setName("");
    setLeaderName("Leader");
    setEngine("harness");
    props.onClose();
  };

  const create = async () => {
    if (!name.trim() || !leaderName.trim()) return;
    setLoading(true);
    try {
      const team = await props.port.create({
        name: name.trim(),
        workspaceId: props.workspaceId,
        lead: {
          name: leaderName.trim(),
          engine,
          presetId: props.presetId,
        },
      });
      props.onCreated(team);
      close();
    } catch {
      Message.error("Unable to create team");
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      visible={props.visible}
      onCancel={close}
      footer={null}
      title={null}
      closable={false}
      style={{ width: 560, padding: 0, borderRadius: 12, overflow: "hidden" }}
      getPopupContainer={() => document.body}
      unmountOnExit={false}
    >
      <div className="flex items-center justify-between border-b border-border-2 bg-dialog-fill-0 px-24px py-18px">
        <h3 className="m-0 text-16px font-600 text-t-primary">Create Team</h3>
        <Button
          type="text"
          icon={
            <Close size="18" fill="currentColor" className="text-t-secondary" />
          }
          onClick={close}
          className="!h-28px !w-28px !min-w-28px !p-0 !rd-8px hover:!bg-fill-2"
        />
      </div>
      <div className="px-24px py-20px">
        <Form layout="vertical">
          <Form.Item
            label={
              <span className="text-12px font-500 text-t-secondary">
                Team name *
              </span>
            }
          >
            <Input
              ref={inputRef}
              value={name}
              onChange={setName}
              placeholder="Team name"
            />
          </Form.Item>
          <Form.Item
            label={
              <div className="flex flex-col gap-2px">
                <span className="text-12px font-500 text-t-secondary">
                  Team Leader *
                </span>
                <span className="text-11px font-normal leading-16px text-t-tertiary">
                  Receives your instructions and coordinates the team
                </span>
              </div>
            }
          >
            <Input
              value={leaderName}
              onChange={setLeaderName}
              placeholder="Leader name"
            />
          </Form.Item>
          <Form.Item
            label={
              <span className="text-12px font-500 text-t-secondary">Agent</span>
            }
          >
            <div className="max-h-320px overflow-y-auto rounded-12px border border-border-2 bg-fill-1 p-6px">
              {engines.map((item) => {
                const selected = engine === item.id;
                return (
                  <div
                    key={item.id}
                    className={`flex items-center gap-12px rounded-8px px-12px py-9px cursor-pointer transition-colors ${selected ? "bg-aou-1" : "hover:bg-fill-2"}`}
                    style={
                      selected
                        ? { boxShadow: "inset 0 0 0 1px var(--aou-6)" }
                        : undefined
                    }
                    onClick={() => setEngine(item.id)}
                  >
                    <div
                      className="h-16px w-16px flex-shrink-0 rounded-full transition-all"
                      style={{
                        boxSizing: "border-box",
                        border: selected
                          ? "5px solid var(--aou-6)"
                          : "1.5px solid var(--color-border-3)",
                      }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-13px font-500 text-t-primary">
                        {item.name}
                      </div>
                      <div className="text-11px text-t-tertiary">
                        {item.description}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </Form.Item>
        </Form>
      </div>
      <div className="flex justify-end gap-10px border-t border-border-2 bg-dialog-fill-0 px-24px py-16px">
        <Button
          onClick={close}
          className="min-w-80px"
          style={{ borderRadius: 8 }}
        >
          Cancel
        </Button>
        <Button
          type="primary"
          onClick={() => void create()}
          loading={loading}
          disabled={!name.trim() || !leaderName.trim()}
          className="min-w-80px"
          style={{ borderRadius: 8 }}
        >
          Create Team
        </Button>
      </div>
    </Modal>
  );
}
