/** Hosted chat is turned off. Every method answers the same 410 without
    reading the request, so no prompt or credential is used or logged. */
function gone() {
  return Response.json(
    { error: "Hosted chat is turned off." },
    { status: 410, headers: { "Cache-Control": "no-store" } },
  );
}

export const GET = gone;
export const HEAD = gone;
export const POST = gone;
export const PUT = gone;
export const PATCH = gone;
export const DELETE = gone;
export const OPTIONS = gone;
