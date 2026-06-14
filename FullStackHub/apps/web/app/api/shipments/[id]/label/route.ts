import { cookies } from "next/headers";
import { ACCESS_COOKIE } from "@/lib/auth/cookies";
import { apiUrl } from "@/lib/config";

// Proxies the authenticated label PDF from the API so the browser can download it
// without ever seeing the internal API URL or the bearer token.
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await params;
  const token = (await cookies()).get(ACCESS_COOKIE)?.value;
  if (!token) return new Response("Unauthorized", { status: 401 });

  const res = await fetch(`${apiUrl}/api/v1/shipments/${encodeURIComponent(id)}/label`, {
    headers: { authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!res.ok || !res.body) {
    return new Response("Could not generate the label", { status: res.status || 502 });
  }

  return new Response(res.body, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition":
        res.headers.get("content-disposition") ?? `attachment; filename="label-${id}.pdf"`,
    },
  });
}
