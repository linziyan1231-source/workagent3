/** Durable text envelope shared by drafts, queued messages and engine adapters. */
export type FileReference = {
  workspaceId?: string;
  fileId?: string;
  path: string;
  name: string;
};
export type FileReferencePart = { text: string; reference?: FileReference };

export function fileReferenceText(reference: FileReference): string {
  return `项目文件：${JSON.stringify(reference)}`;
}

export function fileReferenceParts(text: string): FileReferencePart[] {
  const parts: FileReferencePart[] = [];
  const pattern =
    /项目文件[：:]\s*("(?:\\.|[^"\\])*"|\{(?:"(?:\\.|[^"\\])*"|[^"\r\n}])*\})/g;
  let end = 0;
  for (const match of text.matchAll(pattern)) {
    let reference: FileReference;
    try {
      const value = JSON.parse(match[1]!);
      const path = typeof value === "string" ? value : value?.path;
      if (typeof path !== "string" || !path) continue;
      if (
        typeof value === "object" &&
        value.workspaceId !== undefined &&
        typeof value.workspaceId !== "string"
      )
        continue;
      reference = {
        path,
        ...(typeof value?.fileId === "string" ? { fileId: value.fileId } : {}),
        name:
          typeof value?.name === "string"
            ? value.name
            : path.split(/[\\/]/).at(-1)!,
        ...(typeof value?.workspaceId === "string"
          ? { workspaceId: value.workspaceId }
          : {}),
      };
    } catch {
      continue;
    }
    if (match.index! > end) parts.push({ text: text.slice(end, match.index) });
    parts.push({ text: match[0], reference });
    end = match.index! + match[0].length;
  }
  if (end < text.length) parts.push({ text: text.slice(end) });
  return parts;
}

export function fileReferenceLabel(text: string): string {
  return fileReferenceParts(text)
    .map((part) => part.reference?.name ?? part.text)
    .join("");
}
