export type FileMetadata = {
  name: string;
  path?: string;
  size?: number;
  type?: string;
  lastModified?: number;
};
export const allSupportedExts: string[] = [];

export function getCleanFileNames(paths: string[]) {
  return paths.map((path) => path.split(/[\\/]/).pop() ?? path);
}

export function getFilesFromDropEvent(event: DragEvent): FileMetadata[] {
  return Array.from(event.dataTransfer?.files ?? []).map((file) => ({
    name: file.name,
    path: file.name,
    size: file.size,
    type: file.type,
    lastModified: file.lastModified,
  }));
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
