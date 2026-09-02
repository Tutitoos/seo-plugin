import type { APIRoute } from "astro";
import { AuditStore } from "../../../../../../audit-store.mjs";
import { BusinessProfileCaptureStore } from "../../../../../../business-profile-capture-store.mjs";

export const GET: APIRoute = async ({ params }) => {
  try {
    const { manifest } = await new AuditStore().get(params.id);
    const bytes = await new BusinessProfileCaptureStore().readAsset(manifest.businessProfileCapture, params.assetId);
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    return new Response(body, { headers: { "Content-Type": "image/webp", "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; sandbox" } });
  } catch { return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } }); }
};
