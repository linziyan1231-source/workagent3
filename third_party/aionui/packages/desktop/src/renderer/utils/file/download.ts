/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { base64ToBlob, BINARY_MIME_MAP } from './base64';

function triggerBlobDownload(blob: Blob, file_name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = file_name;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function triggerStreamDownload(file_path: string, file_name: string, workspace?: string): void {
  const url = new URL('/api/fs/download', window.location.href);
  url.searchParams.set('path', file_path);
  if (workspace) url.searchParams.set('workspace', workspace);
  const link = document.createElement('a');
  link.href = url.toString();
  link.download = file_name;
  link.rel = 'noopener';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

const nativeDownloadClickGate = new Set<string>();
const NATIVE_DOWNLOAD_DEDUP_MS = 2000;

function triggerDeduplicatedStreamDownload(file_path: string, file_name: string, workspace?: string): void {
  const key = `${workspace ?? ''}\n${file_path}`;
  if (nativeDownloadClickGate.has(key)) {
    // The first browser-native download is still active. Treat a rapid repeat
    // as the same user action instead of surfacing a false failure toast.
    return;
  }
  nativeDownloadClickGate.add(key);
  window.setTimeout(() => nativeDownloadClickGate.delete(key), NATIVE_DOWNLOAD_DEDUP_MS);
  triggerStreamDownload(file_path, file_name, workspace);
}

/**
 * Download a file from disk. WebUI delegates to the browser's native download
 * stack so response bytes are streamed directly to disk. Electron and shared
 * projects retain the IPC/base64 path because they do not have a same-origin
 * authenticated file-stream endpoint. The server exposes strict Range/ETag
 * semantics, so Chrome's native download manager can resume after a transport
 * interruption. Browser UI and retry timing remain browser-controlled.
 */
export async function downloadFileFromPath(file_path: string, file_name: string, workspace?: string): Promise<void> {
  const isSharedProject = file_path.startsWith('shared://') || workspace?.startsWith('shared://');
  if (!isElectronDesktop() && !isSharedProject) {
    triggerDeduplicatedStreamDownload(file_path, file_name, workspace);
    return;
  }

  const dataUrl = await ipcBridge.fs.getImageBase64.invoke({ path: file_path, workspace });
  if (!dataUrl) {
    throw new Error('File data not found');
  }
  const ext = file_name.split('.').pop()?.toLowerCase() ?? '';
  const mimeType = BINARY_MIME_MAP[ext] ?? 'application/octet-stream';
  const blob = base64ToBlob(dataUrl, mimeType);
  triggerBlobDownload(blob, file_name);
}

/**
 * Download in-memory text content as a file.
 */
export function downloadTextContent(content: string, file_name: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  triggerBlobDownload(blob, file_name);
}
