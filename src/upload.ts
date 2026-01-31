/**
 * Upload media (images, video) to nostr.build for hosting.
 * Returns the public URL of the uploaded file.
 */

const NOSTR_BUILD_UPLOAD_URL = "https://nostr.build/api/v2/upload/files";

export async function uploadMedia(file: File): Promise<string> {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(NOSTR_BUILD_UPLOAD_URL, {
    method: "POST",
    body: formData,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upload failed: ${res.status} ${res.statusText}${text ? ` - ${text.slice(0, 200)}` : ""}`);
  }

  const data = await res.json();

  // nostr.build may return: { data: [{ url: "..." }] } or array of objects with url
  if (Array.isArray(data)) {
    const first = data[0];
    if (first?.url) return first.url;
    if (typeof first === "string") return first;
  }
  if (data?.data?.[0]?.url) return data.data[0].url;
  if (data?.url) return data.url;
  if (data?.data?.url) return data.data.url;

  throw new Error("Upload response missing URL");
}
