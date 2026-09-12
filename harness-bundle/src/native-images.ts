import { open } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { WorkspaceStore } from "./workspace-store.js";
import { fileReferenceParts, type FileReference } from "@workagent/contracts";
export type NativeImage = { mimeType: string; data: string };

function sharedReferencePath(
  workspaceId: string,
  workspacePath: string | undefined,
  reference: FileReference,
): string | undefined {
  if (
    !workspaceId.startsWith("shared:") ||
    !workspacePath ||
    (reference.workspaceId && reference.workspaceId !== workspaceId)
  )
    return undefined;
  const path = reference.path.replaceAll("\\", "/");
  if (isAbsolute(path) || path.startsWith("/") || path.includes(":"))
    throw new Error("invalid_relative_path");
  const absolute = resolve(workspacePath, path);
  const local = relative(workspacePath, absolute);
  if (local === ".." || local.startsWith(`..${sep}`) || isAbsolute(local))
    throw new Error("invalid_relative_path");
  return absolute;
}

async function sharedImageStream(path: string) {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("not_a_file");
    return { size: stat.size, stream: file.createReadStream() };
  } catch (error) {
    await file.close();
    throw error;
  }
}

export function nativeFileInput(
  store: WorkspaceStore,
  workspaceId: string,
  content: string,
  workspacePath?: string,
): string {
  return fileReferenceParts(content)
    .map((part) =>
      part.reference
        ? `项目文件：${JSON.stringify(sharedReferencePath(workspaceId, workspacePath, part.reference) ?? store.referencePath(part.reference.workspaceId || workspaceId, part.reference.path, part.reference.fileId))}`
        : part.text,
    )
    .join("");
}

/** Shared project references use their bound root; other references use the employee store.
 * Keep durable messages as paths; base64 is constructed only for the native call. */
export async function nativeImages(
  store: WorkspaceStore,
  workspaceId: string,
  content: string,
  workspacePath?: string,
): Promise<NativeImage[]> {
  // JSON strings preserve spaces, quotes and Chinese filenames without accepting
  // arbitrary absolute paths or remote URLs from message text.
  const references = fileReferenceParts(content).flatMap((part) =>
    part.reference ? [part.reference] : [],
  );
  const selected = [
    ...new Map(
      references.map((reference) => [
        JSON.stringify([
          reference.workspaceId || workspaceId,
          reference.fileId || reference.path,
        ]),
        reference,
      ]),
    ).values(),
  ].filter((reference) => /\.(png|jpe?g|webp|gif)$/i.test(reference.path));
  if (selected.length > 10) throw new Error("too_many_images");
  const images: NativeImage[] = [];
  let total = 0;
  for (const reference of selected) {
    const absolute = sharedReferencePath(workspaceId, workspacePath, reference);
    const { size, stream } = await (absolute
      ? sharedImageStream(absolute)
      : store.readStream(
          reference.workspaceId || workspaceId,
          reference.path,
          reference.fileId,
          true,
        ));
    if (size > 10 * 1024 * 1024 || total + size > 20 * 1024 * 1024) {
      stream.destroy();
      throw new Error("image_too_large");
    }
    const parts: Buffer[] = [];
    let imageSize = 0;
    for await (const chunk of stream) {
      const bytes = Buffer.from(chunk);
      imageSize += bytes.length;
      total += bytes.length;
      if (imageSize > 10 * 1024 * 1024 || total > 20 * 1024 * 1024)
        throw new Error("image_too_large");
      parts.push(bytes);
    }
    const bytes = Buffer.concat(parts);
    const mimeType = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? "image/png"
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        ? "image/jpeg"
        : /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString("ascii"))
          ? "image/gif"
          : bytes.subarray(0, 4).toString("ascii") === "RIFF" &&
              bytes.subarray(8, 12).toString("ascii") === "WEBP"
            ? "image/webp"
            : undefined;
    if (!mimeType) throw new Error("invalid_image_content");
    images.push({ mimeType, data: bytes.toString("base64") });
  }
  return images;
}
