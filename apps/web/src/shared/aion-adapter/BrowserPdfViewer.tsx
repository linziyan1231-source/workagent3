import { Button, Message } from "@arco-design/web-react";
import { usePreviewToolbarExtras } from "@/renderer/pages/conversation/Preview/context/PreviewToolbarExtrasContext";
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { workspacePort } from "../../features/workspace/workspacePort.js";
import {
  ipcBridge,
  personalWorkspaceLocation,
  sharedProjectIDFromPath,
} from "./common.js";

const base64ToBytes = (encoded: string) => {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1)
    bytes[index] = binary.charCodeAt(index);
  return bytes;
};

interface BrowserPdfViewerProps {
  file_path?: string;
  content?: string;
  hideToolbar?: boolean;
}

/** Browser host for the formal WorkAgent2 PDF viewer's Electron-only webview. */
const BrowserPdfViewer: React.FC<BrowserPdfViewerProps> = ({
  file_path,
  content,
  hideToolbar = false,
}) => {
  const { t } = useTranslation();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [messageApi, messageContextHolder] = Message.useMessage();
  const toolbarExtrasContext = usePreviewToolbarExtras();
  const usePortalToolbar = Boolean(toolbarExtrasContext) && !hideToolbar;
  const sharedPath =
    file_path && sharedProjectIDFromPath(file_path) ? file_path : null;
  const [sharedSrc, setSharedSrc] = useState<string | null>(null);
  const [sharedLoadFailed, setSharedLoadFailed] = useState(false);

  // Shared project files have no runtime-workspace preview URL; pull the bytes
  // through the shared read-buffer port and render them via the same sandboxed
  // iframe pipeline as personal PDFs.
  useEffect(() => {
    if (!sharedPath) return;
    let objectUrl: string | null = null;
    let cancelled = false;
    setSharedSrc(null);
    setSharedLoadFailed(false);
    ipcBridge.fs.readFileBuffer
      .invoke({ path: sharedPath })
      .then((encoded) => {
        if (cancelled) return;
        const bytes = encoded ? base64ToBytes(encoded) : null;
        if (!bytes || bytes.length === 0) {
          setSharedLoadFailed(true);
          return;
        }
        objectUrl = URL.createObjectURL(
          new Blob([bytes], { type: "application/pdf" }),
        );
        setSharedSrc(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setSharedLoadFailed(true);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [sharedPath]);

  const pdfSrc = useMemo(() => {
    if (sharedPath) return sharedSrc ?? "";
    if (file_path) {
      const location = personalWorkspaceLocation(undefined, file_path);
      if (location)
        return workspacePort.previewUrl(
          location.workspaceId,
          location.relativePath,
        );
    }
    return content ?? "";
  }, [content, file_path, sharedPath, sharedSrc]);

  const handleOpenInSystem = useCallback(async () => {
    if (!file_path) {
      messageApi.error?.(t("preview.errors.openWithoutPath"));
      return;
    }
    try {
      await ipcBridge.shell.openFile.invoke(file_path);
      messageApi.success?.(t("preview.openInSystemSuccess"));
    } catch {
      messageApi.error?.(t("preview.openInSystemFailed"));
    }
  }, [file_path, messageApi, t]);

  useEffect(() => {
    if (sharedPath) {
      setError(sharedLoadFailed ? t("preview.pdf.loadFailed") : null);
      setLoading(!sharedLoadFailed);
      return;
    }
    setError(pdfSrc ? null : t("preview.pdf.pathMissing"));
    setLoading(Boolean(pdfSrc));
  }, [pdfSrc, sharedLoadFailed, sharedPath, t]);

  useEffect(() => {
    if (!usePortalToolbar || !toolbarExtrasContext || loading || error) return;
    toolbarExtrasContext.setExtras({
      left: (
        <div className="flex items-center gap-8px">
          <span className="text-13px text-t-secondary">
            📄 {t("preview.pdf.title")}
          </span>
          <span className="text-11px text-t-tertiary">
            {t("preview.readOnlyLabel")}
          </span>
        </div>
      ),
      right: null,
    });
    return () => toolbarExtrasContext.setExtras(null);
  }, [error, loading, t, toolbarExtrasContext, usePortalToolbar]);

  if (error) {
    return (
      <div className="flex items-center justify-center h-full">
        {messageContextHolder}
        <div className="text-center">
          <div className="text-16px text-t-error mb-8px">❌ {error}</div>
          <div className="text-12px text-t-secondary">
            {t("preview.pdf.unableDisplay")}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full bg-bg-1 flex flex-col">
      {messageContextHolder}
      {!usePortalToolbar && !hideToolbar && (
        <div className="flex items-center justify-between h-40px px-12px bg-bg-2 flex-shrink-0">
          <div className="flex items-center gap-8px">
            <span className="text-13px text-t-secondary">
              📄 {t("preview.pdf.title")}
            </span>
            <span className="text-11px text-t-tertiary">
              {t("preview.readOnlyLabel")}
            </span>
          </div>
          {file_path && (
            <Button
              size="mini"
              type="text"
              onClick={handleOpenInSystem}
              title={t("preview.openInSystemApp")}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
              <span>{t("preview.openInSystemApp")}</span>
            </Button>
          )}
        </div>
      )}
      <div className="relative flex-1 overflow-hidden bg-bg-1">
        {loading && (
          <div className="absolute inset-0 z-1 flex items-center justify-center bg-bg-1">
            <div className="text-14px text-t-secondary">
              {t("preview.loading")}
            </div>
          </div>
        )}
        {pdfSrc && (
          <iframe
            key={pdfSrc}
            src={pdfSrc}
            title={t("preview.pdf.title")}
            className="w-full h-full border-0"
            onLoad={() => setLoading(false)}
            onError={() => {
              setError(t("preview.pdf.loadFailed"));
              setLoading(false);
            }}
          />
        )}
      </div>
    </div>
  );
};

export default BrowserPdfViewer;
