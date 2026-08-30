import { Empty, Message, Tree } from "@arco-design/web-react";
import type { RefInputType } from "@arco-design/web-react/es/Input/interface";
import type { NodeInstance } from "@arco-design/web-react/es/Tree/interface";
import { Right } from "@icon-park/react";
import type {
  Workspace,
  WorkspaceAsset,
  WorkspaceEntry,
} from "@workagent/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import FlexFullContainer from "@renderer/components/layout/FlexFullContainer";
import FileTypeIcon from "@renderer/pages/conversation/Workspace/components/FileTypeIcon";
import WorkspaceContextMenu from "@renderer/pages/conversation/Workspace/components/WorkspaceContextMenu";
import WorkspaceDialogs from "@renderer/pages/conversation/Workspace/components/WorkspaceDialogs";
import WorkspaceTabBar from "@renderer/pages/conversation/Workspace/components/WorkspaceTabBar";
import WorkspaceToolbar from "@renderer/pages/conversation/Workspace/components/WorkspaceToolbar";
import type {
  DeleteModalState,
  RenameModalState,
  WorkspaceTab,
} from "@renderer/pages/conversation/Workspace/types";
import "@renderer/pages/conversation/Workspace/workspace.css";
import type { IDirOrFile } from "../../shared/aion-adapter/ipcBridge.js";
import { workspacePort } from "./workspacePort.js";

type Props = {
  selectedId?: string;
  sessionId?: string;
  onSelect: (workspaceId: string) => void;
  onAssetAdded: (asset: WorkspaceAsset) => void;
};

const toNode = (entry: WorkspaceEntry): IDirOrFile => ({
  name: entry.name,
  fullPath: entry.path,
  relativePath: entry.path,
  isDir: entry.kind === "directory",
  isFile: entry.kind === "file",
});

const parentPath = (path: string) => path.split("/").slice(0, -1).join("/");
const joinPath = (parent: string, name: string) =>
  parent ? `${parent}/${name}` : name;

function replaceChildren(
  nodes: IDirOrFile[],
  path: string,
  children: IDirOrFile[],
): IDirOrFile[] {
  return nodes.map((node) =>
    node.relativePath === path
      ? { ...node, children }
      : node.children
        ? { ...node, children: replaceChildren(node.children, path, children) }
        : node,
  );
}

function filterNodes(nodes: IDirOrFile[], query: string): IDirOrFile[] {
  if (!query) return nodes;
  const normalized = query.toLocaleLowerCase();
  return nodes.flatMap((node) => {
    const children = node.children
      ? filterNodes(node.children, normalized)
      : undefined;
    return node.name.toLocaleLowerCase().includes(normalized) || children?.length
      ? [{ ...node, children }]
      : [];
  });
}

export function WorkspacePanel({
  selectedId,
  sessionId,
  onSelect,
  onAssetAdded,
}: Props) {
  const { t } = useTranslation();
  const [messageApi, messageContext] = Message.useMessage();
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [files, setFiles] = useState<IDirOrFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("files");
  const [collapsed, setCollapsed] = useState(false);
  const [showSearch] = useState(true);
  const [searchText, setSearchText] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    node: IDirOrFile | null;
  }>({ visible: false, x: 0, y: 0, node: null });
  const [renameModal, setRenameModal] = useState<RenameModalState>({
    visible: false,
    value: "",
    target: null,
  });
  const [renameLoading, setRenameLoading] = useState(false);
  const [deleteModal, setDeleteModal] = useState<DeleteModalState>({
    visible: false,
    target: null,
    loading: false,
  });
  const fileInput = useRef<HTMLInputElement>(null);
  const searchInputRef = useRef<RefInputType>(null);

  const refresh = useCallback(async () => {
    if (!selectedId) return;
    setLoading(true);
    try {
      setFiles((await workspacePort.files(selectedId, "")).map(toNode));
      setExpandedKeys([]);
    } catch {
      messageApi.error?.(t("conversation.workspace.dragFailed"));
    } finally {
      setLoading(false);
    }
  }, [messageApi, selectedId, t]);

  useEffect(() => {
    void workspacePort
      .list()
      .then((items) => {
        setWorkspaces(items);
        if (!selectedId && items[0]) onSelect(items[0].id);
      })
      .catch(() => messageApi.error?.(t("conversation.workspace.dragFailed")));
  }, [messageApi, onSelect, selectedId, t]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const close = () =>
      setContextMenu((current) => ({ ...current, visible: false }));
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  const treeData = useMemo(
    () => filterNodes(files, searchText.trim()),
    [files, searchText],
  );
  const selectedNode = useMemo(() => {
    const find = (nodes: IDirOrFile[]): IDirOrFile | undefined => {
      for (const node of nodes) {
        if (node.relativePath === selected[0]) return node;
        const child = node.children ? find(node.children) : undefined;
        if (child) return child;
      }
    };
    return find(files);
  }, [files, selected]);
  const uploadDirectory =
    selectedNode?.isDir === true
      ? selectedNode.relativePath
      : selectedNode
        ? parentPath(selectedNode.relativePath)
        : "";

  async function loadChildren(node: NodeInstance) {
    const data = node.props.dataRef as IDirOrFile | undefined;
    if (!selectedId || !data?.isDir) return;
    const children = (
      await workspacePort.files(selectedId, data.relativePath)
    ).map(toNode);
    setFiles((current) =>
      replaceChildren(current, data.relativePath, children),
    );
  }

  async function upload(fileList: FileList | null) {
    if (!selectedId || !fileList) return;
    try {
      for (const file of Array.from(fileList)) {
        await workspacePort.upload(
          selectedId,
          joinPath(uploadDirectory, file.name),
          file,
        );
      }
      await refresh();
    } catch {
      messageApi.error?.(t("conversation.workspace.dragFailed"));
    } finally {
      if (fileInput.current) fileInput.current.value = "";
    }
  }

  const closeContextMenu = () =>
    setContextMenu((current) => ({ ...current, visible: false }));
  const closeRenameModal = () =>
    setRenameModal({ visible: false, value: "", target: null });
  const closeDeleteModal = () =>
    setDeleteModal({ visible: false, target: null, loading: false });

  async function addToChat(node: IDirOrFile) {
    closeContextMenu();
    if (!selectedId || !sessionId || !node.isFile) {
      messageApi.warning?.(t("conversation.workspace.contextMenu.addToChat"));
      return;
    }
    try {
      onAssetAdded(
        await workspacePort.registerArtifact(
          selectedId,
          sessionId,
          node.relativePath,
          node.name,
        ),
      );
      messageApi.success?.(t("conversation.workspace.contextMenu.addedToChat"));
    } catch {
      messageApi.error?.(t("common.failed"));
    }
  }

  async function rename() {
    const target = renameModal.target;
    const name = renameModal.value.trim();
    if (!selectedId || !target || !name) return;
    setRenameLoading(true);
    try {
      await workspacePort.move(
        selectedId,
        target.relativePath,
        joinPath(parentPath(target.relativePath), name),
      );
      closeRenameModal();
      await refresh();
    } catch {
      messageApi.error?.(t("conversation.workspace.contextMenu.renameFailed"));
    } finally {
      setRenameLoading(false);
    }
  }

  async function remove() {
    const target = deleteModal.target;
    if (!selectedId || !target) return;
    setDeleteModal((current) => ({ ...current, loading: true }));
    try {
      await workspacePort.remove(selectedId, target.relativePath);
      closeDeleteModal();
      await refresh();
    } catch {
      messageApi.error?.(t("conversation.workspace.contextMenu.deleteFailed"));
      setDeleteModal((current) => ({ ...current, loading: false }));
    }
  }

  const contextStyle = contextMenu.visible
    ? {
        left: Math.max(8, Math.min(contextMenu.x, window.innerWidth - 248)),
        top: Math.max(8, Math.min(contextMenu.y, window.innerHeight - 260)),
      }
    : undefined;
  const workspaceName =
    workspaces.find((workspace) => workspace.id === selectedId)?.name ??
    t("conversation.workspace.title");

  return (
    <>
      {messageContext}
      <div className="workspace-panel chat-workspace size-full flex flex-col relative">
        <WorkspaceDialogs
          t={t}
          renameModal={renameModal}
          setRenameModal={setRenameModal}
          closeRenameModal={closeRenameModal}
          handleRenameConfirm={() => void rename()}
          renameLoading={renameLoading}
          deleteModal={deleteModal}
          closeDeleteModal={closeDeleteModal}
          handleDeleteConfirm={() => void remove()}
        />
        <WorkspaceTabBar
          t={t}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          changeCount={0}
          branch={null}
        />
        {activeTab === "files" && (
          <WorkspaceToolbar
            t={t}
            isWorkspaceCollapsed={collapsed}
            setIsWorkspaceCollapsed={setCollapsed}
            workspaceDisplayName={workspaceName}
            showSearch={showSearch}
            searchText={searchText}
            setSearchText={setSearchText}
            onSearch={setSearchText}
            searchInputRef={searchInputRef}
            loading={loading}
            refreshWorkspace={() => void refresh()}
            handleUploadDeviceFiles={() => fileInput.current?.click()}
          />
        )}
        {!collapsed && activeTab === "files" && (
          <FlexFullContainer containerClassName="overflow-y-auto">
            <WorkspaceContextMenu
              visible={contextMenu.visible}
              style={contextStyle}
              node={contextMenu.node}
              t={t}
              handleAddToChat={(node) => void addToChat(node)}
              handleOpenNode={async () => {}}
              handleRevealNode={async () => {}}
              handlePreviewFile={async (node) => {
                if (selectedId)
                  window.open(
                    workspacePort.downloadUrl(selectedId, node.relativePath),
                    "_blank",
                    "noopener,noreferrer",
                  );
                closeContextMenu();
              }}
              handleDownloadFile={async (node) => {
                if (!selectedId) return;
                const link = document.createElement("a");
                link.href = workspacePort.downloadUrl(
                  selectedId,
                  node.relativePath,
                );
                link.download = node.name;
                link.click();
                closeContextMenu();
              }}
              handleDeleteNode={(node) => {
                closeContextMenu();
                setDeleteModal({ visible: true, target: node, loading: false });
              }}
              openRenameModal={(node) => {
                closeContextMenu();
                setRenameModal({ visible: true, value: node.name, target: node });
              }}
              closeContextMenu={closeContextMenu}
            />
            {treeData.length === 0 ? (
              <div className="flex-1 size-full flex items-center justify-center px-12px box-border">
                <Empty
                  description={
                    <div>
                      <span className="text-t-secondary font-bold text-14px">
                        {searchText
                          ? t("conversation.workspace.search.empty")
                          : t("conversation.workspace.empty")}
                      </span>
                      <div className="text-t-secondary">
                        {searchText
                          ? ""
                          : t("conversation.workspace.emptyDescription")}
                      </div>
                    </div>
                  }
                />
              </div>
            ) : (
              <Tree
                className="!pl-16px !pr-16px workspace-tree"
                selectedKeys={selected}
                expandedKeys={expandedKeys}
                actionOnClick={["select", "expand"]}
                icons={(nodeProps) => {
                  if (nodeProps.dataRef?.isFile) return { switcherIcon: null };
                  const chevron = (
                    <Right
                      theme="outline"
                      size={14}
                      fill="currentColor"
                      className="workspace-tree-chevron"
                    />
                  );
                  return { switcherIcon: chevron, loadingIcon: chevron };
                }}
                treeData={treeData}
                fieldNames={{
                  children: "children",
                  title: "name",
                  key: "relativePath",
                  isLeaf: "isFile",
                }}
                loadMore={loadChildren}
                renderTitle={(node) => {
                  const data = node.dataRef as IDirOrFile;
                  return (
                    <div
                      className="flex items-center justify-between gap-6px min-w-0"
                      onDoubleClick={() => data.isFile && void addToChat(data)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setSelected([data.relativePath]);
                        setContextMenu({
                          visible: true,
                          x: event.clientX,
                          y: event.clientY,
                          node: data,
                        });
                      }}
                    >
                      <span className="flex items-center gap-4px min-w-0">
                        <FileTypeIcon
                          node={data}
                          expanded={expandedKeys.includes(data.relativePath)}
                        />
                        <span className="overflow-hidden text-ellipsis whitespace-nowrap">
                          {node.title}
                        </span>
                      </span>
                    </div>
                  );
                }}
                onSelect={(keys) => setSelected(keys as string[])}
                onExpand={(keys) => setExpandedKeys(keys as string[])}
              />
            )}
          </FlexFullContainer>
        )}
        {!collapsed && activeTab === "changes" && (
          <FlexFullContainer containerClassName="overflow-y-auto">
            <div className="flex-1 size-full flex items-center justify-center px-12px box-border">
              <Empty description={t("conversation.workspace.changes.empty")} />
            </div>
          </FlexFullContainer>
        )}
        <input
          ref={fileInput}
          type="file"
          multiple
          hidden
          onChange={(event) => void upload(event.target.files)}
        />
      </div>
    </>
  );
}
