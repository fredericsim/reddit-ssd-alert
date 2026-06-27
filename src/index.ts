import { Env, getConfiguredFeedSources, runRedditAlert } from "./alert";

export default {
  async scheduled(
    _controller: ScheduledController,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<void> {
    const result = await runRedditAlert(env);
    console.log("reddit-ssd-alert scheduled run", result);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({
        ok: true,
        service: "reddit-ssd-alert",
        feedSources: getConfiguredFeedSources(env),
        hasNtfyTopic: Boolean(env.NTFY_TOPIC_URL)
      });
    }

    return json({ ok: false, error: "Not found" }, 404);
  }
} satisfies ExportedHandler<Env>;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}
