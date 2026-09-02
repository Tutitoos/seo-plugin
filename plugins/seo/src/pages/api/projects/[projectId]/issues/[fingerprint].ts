import type { APIRoute } from "astro";
import { AuditDetailStore } from "../../../../../audit-detail-store.mjs";
import { validateLocalMutation } from "../../../../../csrf.mjs";

export const POST: APIRoute = async ({ params, request, cookies }) => {
  const body = await request.formData();
  const returnTo = String(body.get("returnTo") || "/");
  const safeReturn = returnTo.startsWith("/audits/") ? returnTo : "/";
  try {
    validateLocalMutation(request, cookies, body.get("csrf"));
    await new AuditDetailStore().manageWorkflow({
      action: "update", projectId: params.projectId, fingerprint: params.fingerprint,
      status: String(body.get("status") || "pending"), owner: String(body.get("owner") || ""),
      dueDate: String(body.get("dueDate") || "") || null, note: String(body.get("note") || ""),
      acceptanceReason: String(body.get("acceptanceReason") || ""),
    });
    const url = new URL(safeReturn, request.url); url.searchParams.set("issueSaved", "1");
    return new Response(null, { status: 303, headers: { Location: `${url.pathname}${url.search}` } });
  } catch (error) {
    const url = new URL(safeReturn, request.url); url.searchParams.set("issueError", error instanceof Error ? error.message : "No se pudo actualizar la incidencia.");
    return new Response(null, { status: 303, headers: { Location: `${url.pathname}${url.search}` } });
  }
};
