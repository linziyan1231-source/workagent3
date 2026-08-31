import { conversationPort } from "../../features/conversation/conversationPort.js";
import { workspacePort } from "../../features/workspace/workspacePort.js";

export type FileMetadata = {
  name: string;
  path?: string;
  size?: number;
  type?: string;
  lastModified?: number;
};
export const imageExts = [
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".bmp",
  ".webp",
  ".svg",
];
export const documentExts = [
  ".pdf",
  ".doc",
  ".docx",
  ".pptx",
  ".xlsx",
  ".odt",
  ".odp",
  ".ods",
];
export const textExts = [
  ".txt",
  ".md",
  ".json",
  ".yaml",
  ".yml",
  ".csv",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
];
export const allSupportedExts = [...imageExts, ...documentExts, ...textExts];
export const UPLOAD_ABORTED_ERROR = "Upload aborted";

export function getFileExtension(fileName: string) {
  const index = fileName.lastIndexOf(".");
  return index === -1 ? "" : fileName.slice(index).toLowerCase();
}

export function getCleanFileNames(paths: string[]) {
  return paths.map((path) => path.split(/[\\/]/).pop() ?? path);
}

export const getCleanFileName = (path: string) =>
  getCleanFileNames([path])[0] ?? path;
export const cleanAionUITimestamp = (name: string) => name;
export const isSupportedFile = (name: string, supported = allSupportedExts) =>
  supported.includes(getFileExtension(name));
export const filterSupportedFiles = (
  files: FileMetadata[],
  supported = allSupportedExts,
) => files.filter((file) => isSupportedFile(file.name, supported));
export const isImageFile = (name: string) =>
  imageExts.includes(getFileExtension(name));
export const isDocumentFile = (name: string) =>
  documentExts.includes(getFileExtension(name));
export const isTextFile = (name: string) =>
  textExts.includes(getFileExtension(name));

export function getFilesFromDropEvent(event: DragEvent): FileMetadata[] {
  return Array.from(event.dataTransfer?.files ?? []).map((file) => ({
    name: file.name,
    path: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
  }));
}

export function getTextFromDropEvent(event: DragEvent) {
  return event.dataTransfer?.getData("text/plain") ?? "";
}

export function formatFileSize(bytes: number, decimals = 2) {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1,
  );
  return `${(bytes / 1024 ** unit).toFixed(unit === 0 ? 0 : decimals)} ${units[unit]}`;
}

type UploadFileOptions = { signal?: AbortSignal };

const stagedFiles = new Map<string, File>();
const stagedPrefix = "workagent-upload://";

export const displayConversationFilePath = (path: string) => {
  if (!path.startsWith(stagedPrefix)) return path;
  const name = path.slice(path.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
};

const throwIfAborted = (signal?: AbortSignal) => {
  if (signal?.aborted) throw new Error(UPLOAD_ABORTED_ERROR);
};

const attachToConversation = async (conversationId: string, file: File) => {
  const session = await conversationPort.get(conversationId);
  return workspacePort.attach(session.workspaceId, conversationId, file);
};

export async function uploadFileViaHttp(
  file: File,
  conversationId = "",
  onProgress?: (percent: number) => void,
  fileName?: string,
  options?: UploadFileOptions,
): Promise<string> {
  throwIfAborted(options?.signal);
  const upload =
    fileName && fileName !== file.name
      ? new File([file], fileName, {
          type: file.type,
          lastModified: file.lastModified,
        })
      : file;
  if (conversationId) {
    const asset = await attachToConversation(conversationId, upload);
    throwIfAborted(options?.signal);
    onProgress?.(100);
    return asset.path;
  }

  const token = `${stagedPrefix}${crypto.randomUUID()}/${encodeURIComponent(upload.name)}`;
  stagedFiles.set(token, upload);
  onProgress?.(100);
  return token;
}

export async function materializeConversationFiles(
  conversationId: string,
  paths: readonly string[],
): Promise<Map<string, string>> {
  const replacements = new Map<string, string>();
  for (const path of paths) {
    const file = stagedFiles.get(path);
    if (!file) continue;
    const asset = await attachToConversation(conversationId, file);
    stagedFiles.delete(path);
    replacements.set(path, asset.path);
  }
  return replacements;
}

export const FileService = {
  async processDroppedFiles(files: FileList | File[], conversationId?: string) {
    const processed: FileMetadata[] = [];
    for (const file of Array.from(files)) {
      const path = await uploadFileViaHttp(file, conversationId);
      processed.push({
        name: file.name,
        path,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified,
      });
    }
    return processed;
  },
};
