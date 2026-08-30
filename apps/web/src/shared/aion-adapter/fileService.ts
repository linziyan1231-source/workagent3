export type FileMetadata = { name: string; path?: string };
export const allSupportedExts: string[] = [];

export function getCleanFileNames(paths: string[]) {
  return paths.map((path) => path.split(/[\\/]/).pop() ?? path);
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
