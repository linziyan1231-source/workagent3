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

export async function uploadFileViaHttp(): Promise<string> {
  throw new Error("workspace_upload_not_available");
}

export const FileService = {
  async processDroppedFiles(files: FileList | File[]) {
    return Array.from(files).map((file) => ({
      name: file.name,
      path: file.name,
      file,
    }));
  },
};
