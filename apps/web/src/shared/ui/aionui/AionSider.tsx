/**
 * Adapted from AionUi Renderer SiderToolbar, ConversationRow, SiderItem and
 * SiderFooter. Electron/router state is replaced by callback props only.
 */
import type { RuntimeSession } from "@workagent/contracts";
import SiderToolbar from "@renderer/components/layout/Sider/SiderNav/SiderToolbar";
import SiderFooter from "@renderer/components/layout/Sider/SiderFooter";
import SiderAssistantEntry from "@renderer/components/layout/Sider/SiderNav/SiderAssistantEntry";
import SiderScheduledEntry from "@renderer/components/layout/Sider/SiderNav/SiderScheduledEntry";
import ConversationRow from "@renderer/pages/conversation/GroupedHistory/ConversationRow";
import type { TChatConversation } from "@/common/config/storage";
import { useLayoutContext } from "@renderer/hooks/context/LayoutContext";
import { getSiderTooltipProps } from "@renderer/utils/ui/siderTooltip";
import { Button, Input, Message, Modal } from "@arco-design/web-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";

type Props = {
  sessions: RuntimeSession[];
  activeId?: string;
  query: string;
  username: string;
  busy: boolean;
  onQuery: (value: string) => void;
  onNew: () => void;
  onSelect: (session: RuntimeSession) => void;
  onRename: (session: RuntimeSession, title: string) => Promise<boolean>;
  onDelete: (session: RuntimeSession) => Promise<boolean>;
  onBatchDelete: (sessions: RuntimeSession[]) => Promise<boolean>;
  onSettings: () => void;
  onAssistants: () => void;
  assistantsActive: boolean;
  onScheduled: () => void;
  scheduledActive: boolean;
  onLogout: () => void;
  onClose: () => void;
};

export function AionSider(props: Props) {
  const layout = useLayoutContext();
  const [batchMode, setBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set<string>());
  const [menuVisibleId, setMenuVisibleId] = useState<string>();
  const [pinnedIds, setPinnedIds] = useState(() => new Set<string>());
  const [renameTarget, setRenameTarget] = useState<RuntimeSession>();
  const [renameName, setRenameName] = useState("");
  const [renameLoading, setRenameLoading] = useState(false);
  const { t } = useTranslation();
  const isMobile = layout?.isMobile ?? false;
  const tooltipProps = getSiderTooltipProps(false);
  const visible = props.sessions.filter((session) =>
    session.title.toLocaleLowerCase().includes(props.query.toLocaleLowerCase()),
  );
  const asRendererConversation = (
    session: RuntimeSession,
  ): TChatConversation =>
    ({
      id: session.id,
      name: session.title,
      type: session.engine === "codex" ? "codex" : "acp",
      created_at: Date.parse(session.createdAt),
      modified_at: Date.parse(session.updatedAt),
      source: "workagent",
      status: "finished",
      extra: {
        backend: session.engine,
        workspace: session.workspaceId,
        is_project_workspace: false,
        preset_assistant_id: session.preset.presetId,
        pinned: pinnedIds.has(session.id),
      },
    }) as TChatConversation;

  const closeRename = () => {
    setRenameTarget(undefined);
    setRenameName("");
  };

  const confirmRename = async () => {
    const title = renameName.trim();
    if (!renameTarget || !title) return;
    setRenameLoading(true);
    try {
      if (await props.onRename(renameTarget, title)) {
        closeRename();
        Message.success(t("conversation.history.renameSuccess"));
      } else {
        Message.error(t("conversation.history.renameFailed"));
      }
    } finally {
      setRenameLoading(false);
    }
  };

  const confirmDelete = (session: RuntimeSession) => {
    Modal.confirm({
      title: t("conversation.history.deleteTitle"),
      content: t("conversation.history.deleteConfirm"),
      okText: t("conversation.history.confirmDelete"),
      cancelText: t("conversation.history.cancelDelete"),
      okButtonProps: { status: "warning" },
      onOk: async () => {
        if (await props.onDelete(session))
          Message.success(t("conversation.history.deleteSuccess"));
        else Message.error(t("conversation.history.deleteFailed"));
      },
      style: { borderRadius: "12px" },
      alignCenter: true,
      getPopupContainer: () => document.body,
    });
  };

  const confirmBatchDelete = (items: RuntimeSession[]) => {
    if (items.length === 0) return;
    Modal.confirm({
      title: t("conversation.history.batchDelete"),
      content: t("conversation.history.batchDeleteConfirm", {
        count: items.length,
      }),
      okText: t("conversation.history.confirmDelete"),
      cancelText: t("conversation.history.cancelDelete"),
      okButtonProps: { status: "warning" },
      onOk: async () => {
        if (await props.onBatchDelete(items)) {
          Message.success(
            t("conversation.history.batchDeleteSuccess", {
              count: items.length,
            }),
          );
          setSelectedIds(new Set());
          setBatchMode(false);
        } else {
          Message.error(t("conversation.history.deleteFailed"));
        }
      },
      style: { borderRadius: "12px" },
      alignCenter: true,
      getPopupContainer: () => document.body,
    });
  };
  return (
    <div className="size-full min-h-0 flex flex-col">
      <Modal
        title={t("conversation.history.renameTitle")}
        visible={renameTarget !== undefined}
        onOk={confirmRename}
        onCancel={closeRename}
        okText={t("conversation.history.saveName")}
        cancelText={t("conversation.history.cancelEdit")}
        confirmLoading={renameLoading}
        okButtonProps={{ disabled: !renameName.trim() }}
        style={{ borderRadius: "12px" }}
        alignCenter
        getPopupContainer={() => document.body}
      >
        <Input
          autoFocus
          value={renameName}
          onChange={setRenameName}
          onPressEnter={confirmRename}
          placeholder={t("conversation.history.renamePlaceholder")}
          allowClear
        />
      </Modal>
      <div className="flex-1 min-h-0 overflow-hidden flex flex-col gap-2px">
        <SiderToolbar
          isMobile={isMobile}
          isBatchMode={batchMode}
          collapsed={false}
          siderTooltipProps={tooltipProps}
          onNewChat={() => {
            if (!props.busy) props.onNew();
          }}
          onToggleBatchMode={() => setBatchMode((active) => !active)}
        />
        <SiderAssistantEntry
          isMobile={isMobile}
          isActive={props.assistantsActive}
          collapsed={false}
          siderTooltipProps={tooltipProps}
          onClick={props.onAssistants}
        />
        <SiderScheduledEntry
          isMobile={isMobile}
          isActive={props.scheduledActive}
          collapsed={false}
          siderTooltipProps={tooltipProps}
          onClick={props.onScheduled}
        />
        <div className="shrink-0 mt-6px mb-2px mx-10px h-1px bg-[var(--color-border-2)]" />
        {batchMode && (
          <div className="px-12px pb-8px pt-2px sticky top-0 z-20 bg-[var(--bg-2)]">
            <div className="rd-8px bg-fill-1 p-10px flex flex-col gap-8px border border-solid border-[rgba(var(--primary-6),0.08)]">
              <div className="text-12px leading-18px text-t-secondary">
                {t("conversation.history.selectedCount", {
                  count: selectedIds.size,
                })}
              </div>
              <div className="grid grid-cols-2 gap-6px">
                <Button
                  className="!w-full !justify-center !min-w-0 !h-30px !px-8px !text-12px whitespace-nowrap"
                  size="mini"
                  type="secondary"
                  onClick={() =>
                    setSelectedIds(
                      selectedIds.size === visible.length
                        ? new Set()
                        : new Set(visible.map((session) => session.id)),
                    )
                  }
                >
                  {selectedIds.size === visible.length && visible.length > 0
                    ? t("common.cancel")
                    : t("conversation.history.selectAll")}
                </Button>
                <Button
                  className="!w-full !justify-center !min-w-0 !h-30px !px-8px !text-12px whitespace-nowrap"
                  size="mini"
                  status="warning"
                  disabled={selectedIds.size === 0}
                  onClick={() => {
                    confirmBatchDelete(
                      visible.filter((session) => selectedIds.has(session.id)),
                    );
                  }}
                >
                  {t("conversation.history.batchDelete")}
                </Button>
              </div>
            </div>
          </div>
        )}
        <div className="sider-section-label flex items-center px-12px h-28px select-none mt-8px">
          <span className="sider-section-title text-14px text-t-tertiary font-[500] leading-none">
            {t("conversation.history.recents")}
          </span>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto aion-sider__scroll">
          {visible.map((session) => {
            const conversation = asRendererConversation(session);
            return (
              <ConversationRow
                key={session.id}
                conversation={conversation}
                isGenerating={props.busy && session.id === props.activeId}
                hasCompletionUnread={false}
                collapsed={false}
                tooltipEnabled={false}
                batchMode={batchMode}
                checked={selectedIds.has(session.id)}
                selected={session.id === props.activeId}
                menuVisible={menuVisibleId === session.id}
                onToggleChecked={() =>
                  setSelectedIds((current) => {
                    const next = new Set(current);
                    if (next.has(session.id)) next.delete(session.id);
                    else next.add(session.id);
                    return next;
                  })
                }
                onConversationClick={() => props.onSelect(session)}
                onOpenMenu={() => setMenuVisibleId(session.id)}
                onMenuVisibleChange={(_id, visible) =>
                  setMenuVisibleId(visible ? session.id : undefined)
                }
                onEditStart={() => {
                  setRenameTarget(session);
                  setRenameName(session.title);
                }}
                onDelete={() => confirmDelete(session)}
                onTogglePin={() =>
                  setPinnedIds((current) => {
                    const next = new Set(current);
                    if (next.has(session.id)) next.delete(session.id);
                    else next.add(session.id);
                    return next;
                  })
                }
                onToggleWeixinReminder={() => undefined}
                getJobStatus={() => "none"}
              />
            );
          })}
        </div>
      </div>
      <SiderFooter
        isMobile={isMobile}
        isSettings={false}
        theme="light"
        siderTooltipProps={tooltipProps}
        onSettingsClick={props.onSettings}
        onThemeToggle={() => undefined}
        showLogout
        onLogoutClick={props.onLogout}
      />
    </div>
  );
}
