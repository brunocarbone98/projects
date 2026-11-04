import { apiUrl } from "@/lib/config";

// Railway's deploy health check (railway.json): a new deployment takes traffic only once this answers
// 200, which needs the web server and the API behind it (migrated, configured) both up. Until then
// the previous deployment keeps serving, so a release that cannot start never replaces a working one.
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  try {
    const res = await fetch(`${apiUrl}/health`, {
      cache: "no-store",
      signal: AbortSignal.timeout(5_000),
    });
    if (res.ok) return Response.json({ status: "ok", service: "web" });
  } catch {
    // The API is not answering yet; report it below.
  }
  return Response.json({ status: "unavailable", service: "web" }, { status: 503 });
}
