/**
 * Adapted from AionUi Renderer SiderToolbar, ConversationRow, SiderItem and
 * SiderFooter. Electron/router state is replaced by callback props only.
 */
import {
  DeleteOne,
  EditOne,
  MessageOne,
  Search,
  ToLeft,
} from "@icon-park/react";
import type { RuntimeSession } from "@workagent/contracts";
import SiderItem from "@renderer/components/layout/Sider/SiderItem";
import SiderToolbar from "@renderer/components/layout/Sider/SiderNav/SiderToolbar";
import SiderFooter from "@renderer/components/layout/Sider/SiderFooter";
import { useLayoutContext } from "@renderer/hooks/context/LayoutContext";
import { getSiderTooltipProps } from "@renderer/utils/ui/siderTooltip";
import { useState } from "react";
import { BrandLogo } from "./BrandLogo.js";

type Props = {
  sessions: RuntimeSession[];
  activeId?: string;
  query: string;
  username: string;
  busy: boolean;
  onQuery: (value: string) => void;
  onNew: () => void;
  onSelect: (session: RuntimeSession) => void;
  onRename: (session: RuntimeSession) => void;
  onDelete: (session: RuntimeSession) => void;
  onSettings: () => void;
  onLogout: () => void;
  onClose: () => void;
};

export function AionSider(props: Props) {
  const layout = useLayoutContext();
  const [batchMode, setBatchMode] = useState(false);
  const isMobile = layout?.isMobile ?? false;
  const tooltipProps = getSiderTooltipProps(false);
  const visible = props.sessions.filter((session) =>
    session.title.toLocaleLowerCase().includes(props.query.toLocaleLowerCase()),
  );
  return (
    <aside className="layout-sider aion-sider">
      <div className="aion-sider__brand">
        <BrandLogo size={30} />
        <strong>WorkAgent</strong>
        <button
          className="aion-sider__collapse"
          type="button"
          aria-label="Collapse sidebar"
          onClick={props.onClose}
        >
          <ToLeft size="16" />
        </button>
      </div>
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
        <label className="aion-sider__search h-34px flex items-center gap-8px px-10px rd-8px">
          <Search theme="outline" size="15" />
          <input
            value={props.query}
            onChange={(event) => props.onQuery(event.target.value)}
            placeholder="Search"
          />
        </label>
        <div className="sider-section-label sider-section-title px-10px pt-12px pb-4px text-12px text-t-tertiary">
          Recent
        </div>
        <nav
          className="flex-1 min-h-0 overflow-y-auto aion-sider__scroll"
          aria-label="Conversations"
        >
          {visible.map((session) => (
            <SiderItem
              key={session.id}
              icon={<MessageOne theme="outline" size="16" />}
              name={session.title}
              selected={session.id === props.activeId}
              menuItems={[
                {
                  key: "rename",
                  icon: <EditOne size="14" />,
                  label: "Rename",
                },
                {
                  key: "delete",
                  icon: <DeleteOne size="14" />,
                  label: "Delete",
                  danger: true,
                },
              ]}
              onClick={() => props.onSelect(session)}
              onMenuAction={(key) =>
                key === "rename"
                  ? props.onRename(session)
                  : props.onDelete(session)
              }
            />
          ))}
          {visible.length === 0 && (
            <div className="px-10px py-8px text-12px text-t-tertiary">
              No conversations
            </div>
          )}
        </nav>
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
    </aside>
  );
}
