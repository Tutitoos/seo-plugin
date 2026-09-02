import type { APIRoute } from "astro";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { insideDataRoot, safeId } from "../../../../../../../data-root.mjs";

const TYPES: Record<string,string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
export const GET: APIRoute = async ({ params }) => {
  try {
    const auditId = safeId(params.id, "auditId"), pageId = safeId(params.pageId, "pageId");
    const relative = String(params.path || "");
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(relative) || !TYPES[extname(relative).toLowerCase()]) return new Response("Not found", { status: 404 });
    const file = await readFile(insideDataRoot("audits", auditId, "pages", pageId, "assets", relative));
    const body = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer;
    return new Response(body, { headers: { "Content-Type": TYPES[extname(relative).toLowerCase()], "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" } });
  } catch { return new Response("Not found", { status: 404 }); }
};
