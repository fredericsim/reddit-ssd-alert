import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeSeenPostIds, parseRedditAtomFeed, runRedditAlert } from "./alert";

const sampleFeed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
  <entry>
    <author><name>/u/example</name></author>
    <content type="html">&lt;span&gt;&lt;a href=&quot;https://store.example/ssd?x=1&amp;amp;y=2&quot;&gt;[link]&lt;/a&gt;&lt;/span&gt; &lt;span&gt;&lt;a href=&quot;https://old.reddit.com/r/buildapcsales/comments/abc123/example/&quot;&gt;[comments]&lt;/a&gt;&lt;/span&gt;</content>
    <id>t3_abc123</id>
    <media:thumbnail url="https://images.example/ssd.jpg?width=640&amp;crop=smart" />
    <link href="https://old.reddit.com/r/buildapcsales/comments/abc123/example/" />
    <published>2026-06-22T12:00:00+00:00</published>
    <title>[SSD] Example 2TB NVMe - $99.99 &amp; free shipping</title>
  </entry>
</feed>`;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseRedditAtomFeed", () => {
  it("extracts post details from Reddit's Atom feed", () => {
    const posts = parseRedditAtomFeed(sampleFeed);

    expect(posts).toEqual([
      {
        id: "t3_abc123",
        title: "[SSD] Example 2TB NVMe - $99.99 & free shipping",
        commentsUrl: "https://old.reddit.com/r/buildapcsales/comments/abc123/example/",
        dealUrl: "https://store.example/ssd?x=1&y=2",
        author: "/u/example",
        publishedAt: "2026-06-22T12:00:00+00:00",
        thumbnailUrl: "https://images.example/ssd.jpg?width=640&crop=smart"
      }
    ]);
  });
});

describe("runRedditAlert", () => {
  it("defers overflow posts instead of marking unalerted posts as seen", async () => {
    const kv = createKv({
      initializedAt: "2026-06-22T00:00:00.000Z",
      seenPostIds: ["t3_existing"]
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(makeFeed(["t3_newest", "t3_middle", "t3_oldest"])))
    );

    const result = await runRedditAlert(
      {
        ALERT_STATE: kv,
        REDDIT_FEED_URL: "https://feed.example/rss",
        MAX_ALERTS_PER_RUN: "2"
      },
      { dryRun: true, now: new Date("2026-06-23T00:00:00.000Z") }
    );

    const state = JSON.parse(kv.read() ?? "{}") as { seenPostIds: string[] };

    expect(result.alertsSent).toBe(2);
    expect(state.seenPostIds).toEqual(["t3_newest", "t3_middle", "t3_existing"]);
    expect(state.seenPostIds).not.toContain("t3_oldest");
  });

  it("does not truncate long ntfy click URLs", async () => {
    const longDealUrl = `https://store.example/products/${"a".repeat(240)}`;
    const kv = createKv({
      initializedAt: "2026-06-22T00:00:00.000Z",
      seenPostIds: []
    });
    let ntfyHeaders: Headers | undefined;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "https://feed.example/rss") {
          return new Response(makeFeed(["t3_newest"], longDealUrl));
        }

        ntfyHeaders = init?.headers as Headers;
        return new Response("{}", { status: 200 });
      })
    );

    await runRedditAlert(
      {
        ALERT_STATE: kv,
        REDDIT_FEED_URL: "https://feed.example/rss",
        NTFY_TOPIC_URL: "https://ntfy.sh/test-topic"
      },
      { now: new Date("2026-06-23T00:00:00.000Z") }
    );

    expect(ntfyHeaders?.get("Click")).toBe(longDealUrl);
  });
});

describe("mergeSeenPostIds", () => {
  it("keeps newest ids first and removes duplicates", () => {
    expect(mergeSeenPostIds(["3", "2"], ["2", "1"], 3)).toEqual(["3", "2", "1"]);
  });

  it("respects the retention limit", () => {
    expect(mergeSeenPostIds(["4", "3"], ["2", "1"], 2)).toEqual(["4", "3"]);
  });
});

function createKv(initialState: unknown): KVNamespace & { read(): string | null } {
  let stored = initialState === null ? null : JSON.stringify(initialState);

  return {
    get: vi.fn(async () => stored),
    put: vi.fn(async (_key: string, value: string) => {
      stored = value;
    }),
    read: () => stored
  } as unknown as KVNamespace & { read(): string | null };
}

function makeFeed(ids: string[], dealUrl = "https://store.example/ssd"): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
${ids.map((id) => makeEntry(id, dealUrl)).join("\n")}
</feed>`;
}

function makeEntry(id: string, dealUrl: string): string {
  const commentsUrl = `https://old.reddit.com/r/buildapcsales/comments/${id.replace(
    "t3_",
    ""
  )}/example/`;

  return `  <entry>
    <author><name>/u/example</name></author>
    <content type="html">&lt;span&gt;&lt;a href=&quot;${dealUrl}&quot;&gt;[link]&lt;/a&gt;&lt;/span&gt; &lt;span&gt;&lt;a href=&quot;${commentsUrl}&quot;&gt;[comments]&lt;/a&gt;&lt;/span&gt;</content>
    <id>${id}</id>
    <link href="${commentsUrl}" />
    <published>2026-06-22T12:00:00+00:00</published>
    <title>[SSD] Example ${id}</title>
  </entry>`;
}
