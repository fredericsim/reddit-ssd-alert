import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FEED_URLS,
  DEFAULT_REDFLAGDEALS_FEED_URLS,
  getConfiguredFeedSources,
  getConfiguredFeedUrls,
  getConfiguredRedflagDealsFeedUrls,
  mergeSeenPostIds,
  parseRedditAtomFeed,
  parseRedflagDealsAtomFeed,
  runRedditAlert
} from "./alert";

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

const sampleRedflagDealsFeed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xml:lang="en">
  <entry>
    <author><name><![CDATA[rfduser]]></name></author>
    <updated>2026-06-27T16:01:10-04:00</updated>
    <published>2026-06-27T16:01:10-04:00</published>
    <id>https://forums.redflagdeals.com/viewtopic.php?t=2818000&amp;p=41130000#p41130000</id>
    <link href="https://forums.redflagdeals.com/viewtopic.php?t=2818000&amp;p=41130000#p41130000" />
    <title type="html"><![CDATA[[Amazon.ca] Crucial P310 2TB M.2 NVMe SSD - $149]]></title>
    <content type="html"><![CDATA[
      See the deal at <a href="https://www.amazon.ca/dp/B0EXAMPLE?tag=1&amp;psc=1" rel="nofollow noreferrer">Amazon</a>
      <a href="https://forums.redflagdeals.com/memberlist.php?mode=viewprofile&amp;u=1">profile</a>
    ]]></content>
  </entry>
  <entry>
    <author><name><![CDATA[laptopuser]]></name></author>
    <published>2026-06-27T15:00:00-04:00</published>
    <id>https://forums.redflagdeals.com/viewtopic.php?t=2817999&amp;p=41129999#p41129999</id>
    <link href="https://forums.redflagdeals.com/viewtopic.php?t=2817999&amp;p=41129999#p41129999" />
    <title type="html"><![CDATA[[Best Buy] Gaming laptop with 1TB SSD - $999]]></title>
    <content type="html"><![CDATA[
      <a href="https://www.bestbuy.ca/example-laptop">Best Buy</a>
    ]]></content>
  </entry>
  <entry>
    <author><name><![CDATA[bikeuser]]></name></author>
    <published>2026-06-27T14:00:00-04:00</published>
    <id>https://forums.redflagdeals.com/viewtopic.php?t=2817998&amp;p=41129998#p41129998</id>
    <link href="https://forums.redflagdeals.com/viewtopic.php?t=2817998&amp;p=41129998#p41129998" />
    <title type="html"><![CDATA[[Amazon.ca] Bike U-Lock - $126]]></title>
    <content type="html"><![CDATA[
      <a href="https://www.amazon.ca/dp/B006QN0MI0">Amazon</a>
    ]]></content>
  </entry>
</feed>`;

afterEach(() => {
  vi.restoreAllMocks();
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

describe("parseRedflagDealsAtomFeed", () => {
  it("extracts SSD deal details and filters non-storage or whole-system posts", () => {
    const posts = parseRedflagDealsAtomFeed(sampleRedflagDealsFeed);

    expect(posts).toEqual([
      {
        id: "redflagdeals:2818000",
        title: "[Amazon.ca] Crucial P310 2TB M.2 NVMe SSD - $149",
        commentsUrl: "https://forums.redflagdeals.com/viewtopic.php?t=2818000",
        dealUrl: "https://www.amazon.ca/dp/B0EXAMPLE?tag=1&psc=1",
        author: "rfduser",
        publishedAt: "2026-06-27T16:01:10-04:00",
        sourceName: "RedFlagDeals"
      }
    ]);
  });
});

describe("runRedditAlert", () => {
  it("fetches multiple configured feeds and alerts the newest unique posts", async () => {
    const kv = createKv({
      initializedAt: "2026-06-22T00:00:00.000Z",
      seenPostIds: []
    });
    const ntfyMessages: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "https://feed-a.example/rss") {
          return new Response(
            makeFeedFromEntries([
              { id: "t3_middle", publishedAt: "2026-06-23T01:00:00+00:00" },
              { id: "t3_duplicate", publishedAt: "2026-06-22T23:00:00+00:00" }
            ])
          );
        }

        if (String(input) === "https://feed-b.example/rss") {
          return new Response(
            makeFeedFromEntries([
              { id: "t3_newest", publishedAt: "2026-06-23T02:00:00+00:00" },
              { id: "t3_duplicate", publishedAt: "2026-06-22T23:00:00+00:00" }
            ])
          );
        }

        ntfyMessages.push(String(init?.body));
        return new Response("{}", { status: 200 });
      })
    );

    const result = await runRedditAlert(
      {
        ALERT_STATE: kv,
        REDDIT_FEED_URLS: "https://feed-a.example/rss\nhttps://feed-b.example/rss",
        MAX_ALERTS_PER_RUN: "2",
        NTFY_TOPIC_URL: "https://ntfy.sh/test-topic"
      },
      { now: new Date("2026-06-23T03:00:00.000Z") }
    );

    const state = JSON.parse(kv.read() ?? "{}") as { seenPostIds: string[] };

    expect(result.checkedPosts).toBe(3);
    expect(result.newPosts).toBe(3);
    expect(result.alertsSent).toBe(2);
    expect(state.seenPostIds).toEqual(["t3_newest", "t3_middle"]);
    expect(ntfyMessages.map((message) => message.split("\n")[0])).toEqual([
      "[SSD] Example t3_middle",
      "[SSD] Example t3_newest"
    ]);
  });

  it("alerts configured Reddit and RedFlagDeals sources through the same ntfy topic", async () => {
    const kv = createKv({
      initializedAt: "2026-06-22T00:00:00.000Z",
      seenPostIds: []
    });
    const ntfyRequests: { click?: string; body?: string }[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "https://reddit.example/rss") {
          return new Response(
            makeFeedFromEntries([
              {
                id: "t3_reddit",
                publishedAt: "2026-06-23T01:00:00+00:00",
                title: "[SSD] Reddit SSD Deal"
              }
            ])
          );
        }

        if (String(input) === "https://rfd.example/feed") {
          return new Response(sampleRedflagDealsFeed);
        }

        const headers = init?.headers as Headers;
        ntfyRequests.push({
          click: headers.get("Click") ?? undefined,
          body: String(init?.body)
        });
        return new Response("{}", { status: 200 });
      })
    );

    const result = await runRedditAlert(
      {
        ALERT_STATE: kv,
        REDDIT_FEED_URLS: "https://reddit.example/rss",
        REDFLAGDEALS_FEED_URLS: "https://rfd.example/feed",
        MAX_ALERTS_PER_RUN: "5",
        NTFY_TOPIC_URL: "https://ntfy.sh/test-topic"
      },
      { now: new Date("2026-06-23T03:00:00.000Z") }
    );

    const state = JSON.parse(kv.read() ?? "{}") as { seenPostIds: string[] };

    expect(result).toMatchObject({
      checkedPosts: 2,
      newPosts: 2,
      alertsSent: 2,
      failedFeeds: 0
    });
    expect(state.seenPostIds).toEqual(["redflagdeals:2818000", "t3_reddit"]);
    expect(ntfyRequests.map((request) => request.click)).toEqual([
      "https://store.example/ssd",
      "https://www.amazon.ca/dp/B0EXAMPLE?tag=1&psc=1"
    ]);
    expect(ntfyRequests[1]?.body).toContain("Source: RedFlagDeals");
    expect(ntfyRequests[1]?.body).toContain(
      "Thread: https://forums.redflagdeals.com/viewtopic.php?t=2818000"
    );
  });

  it("continues processing successful feeds when another feed fails", async () => {
    const kv = createKv({
      initializedAt: "2026-06-22T00:00:00.000Z",
      seenPostIds: []
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "https://feed-a.example/rss") {
          return new Response(makeFeed(["t3_newest"]));
        }

        return new Response("rate limited", {
          status: 429,
          statusText: "Too Many Requests"
        });
      })
    );

    const result = await runRedditAlert(
      {
        ALERT_STATE: kv,
        REDDIT_FEED_URLS: "https://feed-a.example/rss,https://feed-b.example/rss",
        MAX_ALERTS_PER_RUN: "5"
      },
      { dryRun: true, now: new Date("2026-06-23T00:00:00.000Z") }
    );

    const state = JSON.parse(kv.read() ?? "{}") as { seenPostIds: string[] };

    expect(result).toMatchObject({
      checkedPosts: 1,
      newPosts: 1,
      alertsSent: 1,
      failedFeeds: 1,
      stateWritten: true
    });
    expect(state.seenPostIds).toEqual(["t3_newest"]);
    expect(warn).toHaveBeenCalledWith("reddit-ssd-alert skipped failed feeds", [
      {
        kind: "reddit",
        feedUrl: "https://feed-b.example/rss",
        error: "Deal feed request failed: 429 Too Many Requests"
      }
    ]);
  });

  it("does not write partial bootstrap state when a first-run feed fails", async () => {
    const kv = createKv(null);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "https://feed-a.example/rss") {
          return new Response(makeFeed(["t3_newest"]));
        }

        return new Response("rate limited", {
          status: 429,
          statusText: "Too Many Requests"
        });
      })
    );

    const result = await runRedditAlert(
      {
        ALERT_STATE: kv,
        REDDIT_FEED_URLS: "https://feed-a.example/rss,https://feed-b.example/rss",
        MAX_ALERTS_PER_RUN: "5"
      },
      { dryRun: true, now: new Date("2026-06-23T00:00:00.000Z") }
    );

    expect(result).toMatchObject({
      checkedPosts: 1,
      newPosts: 1,
      alertsSent: 0,
      failedFeeds: 1,
      bootstrapped: true,
      stateWritten: false
    });
    expect(kv.read()).toBeNull();
  });

  it("fails the run when every configured feed fails", async () => {
    const kv = createKv({
      initializedAt: "2026-06-22T00:00:00.000Z",
      seenPostIds: ["t3_existing"]
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("server error", {
          status: 500,
          statusText: "Server Error"
        })
      )
    );

    await expect(
      runRedditAlert(
        {
          ALERT_STATE: kv,
          REDDIT_FEED_URLS: "https://feed-a.example/rss,https://feed-b.example/rss"
        },
        { dryRun: true, now: new Date("2026-06-23T00:00:00.000Z") }
      )
    ).rejects.toThrow("All deal feed requests failed");

    const state = JSON.parse(kv.read() ?? "{}") as { seenPostIds: string[] };
    expect(state.seenPostIds).toEqual(["t3_existing"]);
  });

  it("filters bapcsalescanada matches to storage-tagged deal posts", async () => {
    const kv = createKv({
      initializedAt: "2026-06-22T00:00:00.000Z",
      seenPostIds: []
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          makeFeedFromEntries([
            {
              id: "t3_prebuilt",
              title: "[Prebuilt] Gaming PC with 1TB SSD"
            },
            {
              id: "t3_combo",
              title: "[CPU+SSD] Ryzen bundle with WD SN850X"
            },
            {
              id: "t3_ssd",
              title: "[SSD] Example 2TB NVMe"
            }
          ])
        )
      )
    );

    const result = await runRedditAlert(
      {
        ALERT_STATE: kv,
        REDDIT_FEED_URLS: "https://old.reddit.com/r/bapcsalescanada/search.rss?q=title%3ASSD",
        MAX_ALERTS_PER_RUN: "5"
      },
      { dryRun: true, now: new Date("2026-06-23T00:00:00.000Z") }
    );

    const state = JSON.parse(kv.read() ?? "{}") as { seenPostIds: string[] };

    expect(result.checkedPosts).toBe(2);
    expect(result.newPosts).toBe(2);
    expect(result.alertsSent).toBe(2);
    expect(state.seenPostIds).toEqual(["t3_combo", "t3_ssd"]);
  });

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

describe("getConfiguredFeedUrls", () => {
  it("uses the default buildapcsales and bapcsalescanada feeds", () => {
    expect(getConfiguredFeedUrls({})).toEqual(DEFAULT_FEED_URLS);
  });

  it("parses comma-separated and newline-separated feed URLs", () => {
    expect(
      getConfiguredFeedUrls({
        REDDIT_FEED_URLS: "https://feed-a.example/rss, https://feed-b.example/rss\n"
      })
    ).toEqual(["https://feed-a.example/rss", "https://feed-b.example/rss"]);
  });
});

describe("getConfiguredRedflagDealsFeedUrls", () => {
  it("is disabled unless RedFlagDeals feed config is present", () => {
    expect(getConfiguredRedflagDealsFeedUrls({})).toEqual([]);
  });

  it("parses RedFlagDeals feed URLs", () => {
    expect(
      getConfiguredRedflagDealsFeedUrls({
        REDFLAGDEALS_FEED_URLS: "https://rfd.example/feed\n"
      })
    ).toEqual(["https://rfd.example/feed"]);
  });

  it("uses the default RedFlagDeals feed when the config is blank", () => {
    expect(
      getConfiguredRedflagDealsFeedUrls({
        REDFLAGDEALS_FEED_URLS: "\n"
      })
    ).toEqual(DEFAULT_REDFLAGDEALS_FEED_URLS);
  });
});

describe("getConfiguredFeedSources", () => {
  it("returns typed Reddit and RedFlagDeals sources", () => {
    expect(
      getConfiguredFeedSources({
        REDDIT_FEED_URLS: "https://reddit.example/rss",
        REDFLAGDEALS_FEED_URLS: "https://rfd.example/feed"
      })
    ).toEqual([
      { kind: "reddit", url: "https://reddit.example/rss" },
      { kind: "redflagdeals", url: "https://rfd.example/feed" }
    ]);
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
  return makeFeedFromEntries(ids.map((id) => ({ id, dealUrl })));
}

function makeFeedFromEntries(
  entries: { id: string; dealUrl?: string; publishedAt?: string; title?: string }[]
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:media="http://search.yahoo.com/mrss/">
${entries
  .map((entry) =>
    makeEntry(
      entry.id,
      entry.dealUrl ?? "https://store.example/ssd",
      entry.publishedAt,
      entry.title
    )
  )
  .join("\n")}
</feed>`;
}

function makeEntry(
  id: string,
  dealUrl: string,
  publishedAt = "2026-06-22T12:00:00+00:00",
  title = `[SSD] Example ${id}`
): string {
  const commentsUrl = `https://old.reddit.com/r/buildapcsales/comments/${id.replace(
    "t3_",
    ""
  )}/example/`;

  return `  <entry>
    <author><name>/u/example</name></author>
    <content type="html">&lt;span&gt;&lt;a href=&quot;${dealUrl}&quot;&gt;[link]&lt;/a&gt;&lt;/span&gt; &lt;span&gt;&lt;a href=&quot;${commentsUrl}&quot;&gt;[comments]&lt;/a&gt;&lt;/span&gt;</content>
    <id>${id}</id>
    <link href="${commentsUrl}" />
    <published>${publishedAt}</published>
    <title>${title}</title>
  </entry>`;
}
