/**
 * Direct Web adaptation of WorkAgent2 Renderer TeamSiderSection.
 * The original SiderItem hierarchy, tokens and interactions are retained;
 * only useTeamList/ipcBridge are replaced by the WorkAgent3 Team HTTP port.
 */
import type { Team } from "@workagent/contracts";
import {
  Dropdown,
  Input,
  Menu,
  Message,
  Modal,
  Tooltip,
} from "@arco-design/web-react";
import {
  DeleteOne,
  EditOne,
  Peoples,
  Plus,
  Pushpin,
  Right,
} from "@icon-park/react";
import classNames from "classnames";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import SiderItem, {
  type SiderMenuItem,
} from "@renderer/components/layout/Sider/SiderItem";
import { getSiderTooltipProps } from "@renderer/utils/ui/siderTooltip";
import { teamPort, type TeamPort } from "../../../features/team/teamPort.js";
import { AionTeamCreateModal } from "./AionTeamCreateModal.js";

const TEAM_PINNED_KEY = "team-pinned-ids";

type Props = {
  workspaceId: string;
  presetId: string;
  port?: TeamPort;
  onSessionClick?: () => void;
};

export function AionTeamSiderSection({
  workspaceId,
  presetId,
  port = teamPort,
  onSessionClick,
}: Props) {
  const location = useLocation();
  const navigate = useNavigate();
  const [teams, setTeams] = useState<Team[]>([]);
  const [expanded, setExpanded] = useState(
    () => localStorage.getItem("team-section-expanded") !== "false",
  );
  const [createVisible, setCreateVisible] = useState(false);
  const [renameTarget, setRenameTarget] = useState<Team>();
  const [renameName, setRenameName] = useState("");
  const [renameLoading, setRenameLoading] = useState(false);
  const [pinnedIds, setPinnedIds] = useState<string[]>(() => {
    try {
      return JSON.parse(
        localStorage.getItem(TEAM_PINNED_KEY) ?? "[]",
      ) as string[];
    } catch {
      return [];
    }
  });

  const refresh = useCallback(async () => {
    try {
      setTeams(await port.list());
    } catch {
      Message.error("Unable to load teams");
    }
  }, [port]);

  useEffect(() => void refresh(), [refresh]);
  useEffect(() => {
    localStorage.setItem("team-section-expanded", String(expanded));
  }, [expanded]);

  const sortedTeams = useMemo(() => {
    const pinned = teams.filter((team) => pinnedIds.includes(team.id));
    const rest = teams.filter((team) => !pinnedIds.includes(team.id));
    return [...pinned, ...rest];
  }, [pinnedIds, teams]);

  const togglePin = (id: string) => {
    setPinnedIds((current) => {
      const next = current.includes(id)
        ? current.filter((item) => item !== id)
        : [...current, id];
      localStorage.setItem(TEAM_PINNED_KEY, JSON.stringify(next));
      return next;
    });
  };

  const selectTeam = (id: string) => {
    void navigate(`/team/${id}`);
    onSessionClick?.();
  };

  const removeTeam = (team: Team) => {
    Modal.confirm({
      title: "Delete team?",
      content: `“${team.name}” and its task history will be removed.`,
      okText: "Delete",
      cancelText: "Cancel",
      okButtonProps: { status: "warning" },
      style: { borderRadius: 12 },
      alignCenter: true,
      getPopupContainer: () => document.body,
      onOk: async () => {
        await port.remove(team.id);
        if (location.pathname === `/team/${team.id}`) void navigate("/");
        await refresh();
        Message.success("Team deleted");
      },
    });
  };

  const confirmRename = async () => {
    const name = renameName.trim();
    if (!renameTarget || !name) return;
    setRenameLoading(true);
    try {
      await port.rename(renameTarget, name);
      setRenameTarget(undefined);
      await refresh();
      Message.success("Team renamed");
    } finally {
      setRenameLoading(false);
    }
  };

  return (
    <>
      <div className="shrink-0 flex flex-col gap-2px">
        <div
          className="group/label sider-section-label flex items-center px-12px h-28px select-none sticky top-0 z-10 mt-8px cursor-pointer"
          data-testid="team-section-toggle"
          onClick={(event) => {
            if (
              (event.target as HTMLElement).closest(
                '[data-testid="team-create-btn"]',
              )
            )
              return;
            setExpanded((value) => !value);
          }}
        >
          <span className="text-14px text-t-tertiary sider-section-title group-hover/label:text-t-primary transition-colors font-[500] leading-none">
            Team
          </span>
          <span className="ml-2px flex items-center justify-center opacity-0 group-hover/label:opacity-100 transition-opacity text-t-tertiary shrink-0">
            <Right
              theme="outline"
              size={12}
              className={classNames("transition-transform duration-150", {
                "rotate-90": expanded,
              })}
            />
          </span>
          <Dropdown
            trigger="click"
            position="br"
            droplist={
              <Menu onClickMenuItem={() => setCreateVisible(true)}>
                <Menu.Item key="ai">AI collaboration</Menu.Item>
              </Menu>
            }
          >
            <Tooltip content="Create team" position="top">
              <div
                data-testid="team-create-btn"
                className="ml-auto -mr-4px size-20px rd-4px flex items-center justify-center hover:bg-fill-4 transition-all shrink-0 cursor-pointer text-t-secondary hover:text-t-primary"
              >
                <Plus theme="outline" size="14" fill="currentColor" />
              </div>
            </Tooltip>
          </Dropdown>
        </div>
        {expanded &&
          sortedTeams.map((team) => {
            const pinned = pinnedIds.includes(team.id);
            const menuItems: SiderMenuItem[] = [
              {
                key: "pin",
                icon: <Pushpin theme="outline" size="14" />,
                label: pinned ? "Unpin" : "Pin",
              },
              {
                key: "rename",
                icon: <EditOne theme="outline" size="14" />,
                label: "Rename",
              },
              {
                key: "delete",
                icon: <DeleteOne theme="outline" size="14" />,
                label: "Delete",
                danger: true,
              },
            ];
            return (
              <SiderItem
                key={team.id}
                icon={<Peoples theme="outline" size="16" fill="currentColor" />}
                name={team.name}
                selected={location.pathname === `/team/${team.id}`}
                pinned={pinned}
                menuItems={menuItems}
                onClick={() => selectTeam(team.id)}
                onMenuAction={(key) => {
                  if (key === "pin") togglePin(team.id);
                  if (key === "rename") {
                    setRenameTarget(team);
                    setRenameName(team.name);
                  }
                  if (key === "delete") removeTeam(team);
                }}
              />
            );
          })}
      </div>
      <AionTeamCreateModal
        visible={createVisible}
        workspaceId={workspaceId}
        presetId={presetId}
        port={port}
        onClose={() => setCreateVisible(false)}
        onCreated={(team) => {
          setCreateVisible(false);
          void refresh();
          selectTeam(team.id);
        }}
      />
      <Modal
        title="Rename team"
        visible={renameTarget !== undefined}
        onOk={() => void confirmRename()}
        onCancel={() => setRenameTarget(undefined)}
        okText="Save"
        cancelText="Cancel"
        confirmLoading={renameLoading}
        okButtonProps={{ disabled: !renameName.trim() }}
        style={{ borderRadius: 12 }}
        alignCenter
        getPopupContainer={() => document.body}
      >
        <Input
          autoFocus
          value={renameName}
          onChange={setRenameName}
          onPressEnter={() => void confirmRename()}
          placeholder="Team name"
          allowClear
        />
      </Modal>
    </>
  );
}
