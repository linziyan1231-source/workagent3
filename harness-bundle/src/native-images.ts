import type { WorkspaceStore } from "./workspace-store.js";
export type NativeImage = { mimeType: string; data: string };

/** Explicit project references are resolved by the same employee-scoped file store.
 * Keep durable messages as paths; base64 is constructed only for the native call. */
export async function nativeImages(
  store: WorkspaceStore,
  workspaceId: string,
  content: string,
): Promise<NativeImage[]> {
  // JSON strings preserve spaces, quotes and Chinese filenames without accepting
  // arbitrary absolute paths or remote URLs from message text.
  const references = [
    ...content.matchAll(/项目文件[：:]\s*("(?:\\.|[^"\\])*")/g),
  ].map((match) => JSON.parse(match[1]!) as string);
  const selected = [...new Set(references)].filter((path) =>
    /\.(png|jpe?g|webp|gif)$/i.test(path),
  );
  if (selected.length > 10) throw new Error("too_many_images");
  const images: NativeImage[] = [];
  let total = 0;
  for (const path of selected) {
    const { size, stream } = await store.readStream(workspaceId, path);
    total += size;
    if (size > 10 * 1024 * 1024 || total > 20 * 1024 * 1024) {
      stream.destroy();
      throw new Error("image_too_large");
    }
    const parts: Buffer[] = [];
    for await (const chunk of stream) parts.push(Buffer.from(chunk));
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
