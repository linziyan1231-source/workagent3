import { useEffect, useRef, useState } from "react";
import type { Workspace, WorkspaceEntry } from "@workagent/contracts";
import { workspacePort } from "./workspacePort.js";

type Props = {
  selectedId?: string;
  onSelect: (workspaceId: string) => void;
};

const joinPath = (parent: string, name: string) =>
  parent === "" ? name : `${parent}/${name}`;

export function WorkspacePanel({ selectedId, onSelect }: Props) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [path, setPath] = useState("");
  const [notice, setNotice] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void workspacePort
      .list()
      .then((items) => {
        setWorkspaces(items);
        if (selectedId === undefined && items[0] !== undefined)
          onSelect(items[0].id);
      })
      .catch(() => setNotice("Files are temporarily unavailable."));
  }, [onSelect, selectedId]);

  useEffect(() => {
    if (selectedId === undefined) return;
    void refresh(selectedId, path);
  }, [selectedId, path]);

  async function refresh(workspaceId = selectedId, directory = path) {
    if (workspaceId === undefined) return;
    try {
      setEntries(await workspacePort.files(workspaceId, directory));
      setNotice("");
    } catch {
      setNotice("This folder could not be opened.");
    }
  }

  async function upload(files: FileList | null) {
    if (selectedId === undefined || files === null) return;
    try {
      for (const file of files) {
        await workspacePort.upload(selectedId, joinPath(path, file.name), file);
      }
      await refresh();
    } catch {
      setNotice("Upload failed. Files up to 25 MB are supported.");
    } finally {
      if (fileInput.current !== null) fileInput.current.value = "";
    }
  }

  async function createFolder() {
    if (selectedId === undefined) return;
    const name = window.prompt("Folder name")?.trim();
    if (!name) return;
    try {
      await workspacePort.mkdir(selectedId, joinPath(path, name));
      await refresh();
    } catch {
      setNotice("That folder could not be created.");
    }
  }

  return (
    <aside className="workspace-panel" aria-label="Workspace files">
      <div className="workspace-heading">
        <div>
          <span>Workspace</span>
          <strong>Files</strong>
        </div>
        <button
          onClick={createFolder}
          title="New folder"
          aria-label="New folder"
        >
          ＋
        </button>
      </div>
      <select
        value={selectedId ?? ""}
        onChange={(event) => {
          setPath("");
          onSelect(event.target.value);
        }}
        aria-label="Current workspace"
      >
        {workspaces.map((workspace) => (
          <option value={workspace.id} key={workspace.id}>
            {workspace.name}
          </option>
        ))}
      </select>
      <div className="workspace-path">
        <button onClick={() => setPath("")}>Root</button>
        {path && <span>/ {path}</span>}
      </div>
      {notice && <p className="workspace-notice">{notice}</p>}
      <div className="file-list">
        {path && (
          <button
            className="file-row"
            onClick={() => setPath(path.split("/").slice(0, -1).join("/"))}
          >
            <span>↰</span>
            <strong>Parent folder</strong>
          </button>
        )}
        {entries.map((entry) =>
          entry.kind === "directory" ? (
            <button
              className="file-row"
              key={entry.path}
              onClick={() => setPath(entry.path)}
            >
              <span>▰</span>
              <strong>{entry.name}</strong>
            </button>
          ) : (
            <a
              className="file-row"
              key={entry.path}
              href={workspacePort.downloadUrl(selectedId!, entry.path)}
            >
              <span>↧</span>
              <strong>{entry.name}</strong>
              <small>{Math.max(1, Math.ceil(entry.size / 1024))} KB</small>
            </a>
          ),
        )}
        {entries.length === 0 && !notice && (
          <p className="workspace-empty">This folder is empty.</p>
        )}
      </div>
      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(event) => upload(event.target.files)}
      />
      <button
        className="upload-button"
        onClick={() => fileInput.current?.click()}
      >
        Upload files
      </button>
    </aside>
  );
}
