import { Modal } from "@arco-design/web-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { Workspace } from "@workagent/contracts";
import { workspacePort } from "../../features/workspace/workspacePort.js";
import {
  onDirectoryPickRequest,
  rendererWorkspacePath,
  type DirectoryPickRequest,
} from "./common.js";

export function useDeepLink() {}
export function useNotificationClick() {}
export function useBrowserNotification() {}
export function useConversationShortcuts(_options: unknown) {}

// The upstream desktop build shows a native directory dialog; the browser
// host instead offers the user's real WorkAgent workspaces. The selected
// workspace is returned as its renderer pseudo-path (see common.ts
// rendererWorkspacePath), which the rest of the adapter already understands.
function WorkspacePickerModal() {
  const { t } = useTranslation();
  const [request, setRequest] = useState<DirectoryPickRequest | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);

  useEffect(
    () =>
      onDirectoryPickRequest((next) => {
        setRequest(next);
        workspacePort
          .list()
          .then(setWorkspaces)
          .catch(() => setWorkspaces([]));
      }),
    [],
  );

  const close = (paths: string[]) => {
    request?.resolve(paths);
    setRequest(null);
  };

  return (
    <Modal
      visible={request !== null}
      title={t("workspacePicker.title", { defaultValue: "Select workspace" })}
      onCancel={() => close([])}
      footer={null}
      unmountOnExit
    >
      {workspaces.length === 0 ? (
        <div className="py-16px text-center text-t-secondary text-14px">
          {t("workspacePicker.empty", {
            defaultValue: "No workspaces available",
          })}
        </div>
      ) : (
        <div className="flex flex-col gap-8px">
          {workspaces.map((workspace) => (
            <button
              key={workspace.id}
              type="button"
              className="rounded-10px border border-border-2 bg-fill-1 px-12px py-10px text-left text-14px text-t-primary transition-all hover:border-border-1 hover:bg-fill-2"
              onClick={() => close([rendererWorkspacePath(workspace)])}
            >
              {workspace.name}
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}

export function useDirectorySelection(): { contextHolder: ReactNode } {
  return { contextHolder: <WorkspacePickerModal /> };
}
