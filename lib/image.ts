import type { Attachment } from "./chat-types";

const MAX_LONG_EDGE = 1568;
export const ACCEPTED_IMAGE_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
];

/**
 * Prepare an image for upload: downscale client-side so the long edge is at
 * most 1568px (speed + token cost), then base64-encode. GIFs are passed
 * through untouched so animation frames aren't destroyed by the canvas.
 */
export async function prepareImage(file: File): Promise<Attachment> {
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    throw new Error("Unsupported image type. Use png, jpeg, webp or gif.");
  }

  const passthrough = async (): Promise<Attachment> => ({
    mediaType: file.type,
    data: await fileToBase64(file),
    previewUrl: URL.createObjectURL(file),
    name: file.name,
  });

  if (file.type === "image/gif") return passthrough();

  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return passthrough();

  const long = Math.max(bitmap.width, bitmap.height);
  if (long <= MAX_LONG_EDGE) {
    bitmap.close();
    return passthrough();
  }

  const scale = MAX_LONG_EDGE / long;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return passthrough();
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();

  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/webp", 0.9),
  );
  if (!blob) return passthrough();

  return {
    mediaType: "image/webp",
    data: await fileToBase64(blob),
    previewUrl: URL.createObjectURL(blob),
    name: file.name,
  };
}

function fileToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
