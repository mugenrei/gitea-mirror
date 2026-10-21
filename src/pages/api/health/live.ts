import type { APIRoute } from "astro";

/**
 * Minimal process liveness endpoint, intentionally independent of:
 * - SQLite/Better Auth
 * - middleware job recovery
 * - external GitHub/Gitea HTTP calls
 *
 * A 200 means the HTTP process is responsive, NOT that its database,
 * upstream providers, or background mirrors are healthy.
 */
export const GET: APIRoute = () =>
  new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
