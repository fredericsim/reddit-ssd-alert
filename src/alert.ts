import { XMLParser } from "fast-xml-parser";

export const DEFAULT_FEED_URL =
  "https://old.reddit.com/r/buildapcsales/search.rss?q=flair%3A%22SSD%20-%20M.2%22%20OR%20flair%3A%22SSD%20-%20SATA%22%20OR%20flair%3ASSD&restrict_sr=1&sort=new";

export const STATE_KEY = "reddit-ssd-alert-state";

export interface Env {
  ALERT_STATE: KVNamespace;
  NTFY_TOPIC_URL?: string;
  REDDIT_FEED_URL?: string;
  SEEN_POST_LIMIT?: string;
  MAX_ALERTS_PER_RUN?: string;
  SEND_INITIAL_ALERTS?: string;
  NTFY_TITLE?: string;
  NTFY_TAGS?: string;
  NTFY_PRIORITY?: string;
}

export interface RedditPost {
  id: string;
  title: string;
  commentsUrl: string;
  dealUrl?: string;
  author?: string;
  publishedAt?: string;
  thumbnailUrl?: string;
}

export interface AlertState {
  initializedAt: string;
  seenPostIds: string[];
  lastAlertedAt?: string;
}

export interface AlertRunResult {
  checkedPosts: number;
  newPosts: number;
  alertsSent: number;
  bootstrapped: boolean;
  stateWritten: boolean;
}

interface AlertOptions {
  dryRun?: boolean;
  now?: Date;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "",
  textNodeName: "text",
  trimValues: true
});

export async function runRedditAlert(
  env: Env,
  options: AlertOptions = {}
): Promise<AlertRunResult> {
  if (!options.dryRun && !env.NTFY_TOPIC_URL) {
    throw new Error("NTFY_TOPIC_URL is not configured");
  }

  const now = options.now ?? new Date();
  const [state, xml] = await Promise.all([
    readState(env.ALERT_STATE),
    fetchFeed(env.REDDIT_FEED_URL ?? DEFAULT_FEED_URL)
  ]);

  const posts = parseRedditAtomFeed(xml);
  const firstRun = state === null;
  const seenPostIds = new Set(state?.seenPostIds ?? []);
  const newPosts = posts.filter((post) => !seenPostIds.has(post.id));
  const sendInitialAlerts = parseBoolean(env.SEND_INITIAL_ALERTS, false);
  const maxAlertsPerRun = parsePositiveInt(env.MAX_ALERTS_PER_RUN, 5);
  const seenPostLimit = parsePositiveInt(env.SEEN_POST_LIMIT, 100);
  const alertablePosts =
    firstRun && !sendInitialAlerts
      ? []
      : newPosts.slice(0, maxAlertsPerRun).reverse();
  const alertablePostIds = new Set(alertablePosts.map((post) => post.id));
  const postsToMarkSeen =
    firstRun && !sendInitialAlerts
      ? posts
      : posts.filter((post) => alertablePostIds.has(post.id));

  for (const post of alertablePosts) {
    if (!options.dryRun) {
      await sendNtfyAlert(env, post);
    }
  }

  const shouldWriteState = firstRun || newPosts.length > 0;
  if (shouldWriteState) {
    await writeState(env.ALERT_STATE, {
      initializedAt: state?.initializedAt ?? now.toISOString(),
      seenPostIds: mergeSeenPostIds(
        postsToMarkSeen.map((post) => post.id),
        state?.seenPostIds ?? [],
        seenPostLimit
      ),
      lastAlertedAt:
        alertablePosts.length > 0 ? now.toISOString() : state?.lastAlertedAt
    });
  }

  return {
    checkedPosts: posts.length,
    newPosts: newPosts.length,
    alertsSent: alertablePosts.length,
    bootstrapped: firstRun,
    stateWritten: shouldWriteState
  };
}

export function parseRedditAtomFeed(xml: string): RedditPost[] {
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const feed = asRecord(parsed.feed);
  const entries = asArray(feed?.entry);

  return entries
    .map(parseEntry)
    .filter((post): post is RedditPost => Boolean(post));
}

export function mergeSeenPostIds(
  newestIds: string[],
  existingIds: string[],
  limit: number
): string[] {
  const merged: string[] = [];
  const seen = new Set<string>();

  for (const id of [...newestIds, ...existingIds]) {
    if (id && !seen.has(id)) {
      seen.add(id);
      merged.push(id);
    }

    if (merged.length >= limit) {
      break;
    }
  }

  return merged;
}

async function fetchFeed(feedUrl: string): Promise<string> {
  const response = await fetch(feedUrl, {
    headers: {
      Accept: "application/atom+xml,application/xml;q=0.9,*/*;q=0.8",
      "User-Agent": "reddit-ssd-alert/0.1 (+https://github.com/fredericsim/reddit-ssd-alert)"
    },
    cf: {
      cacheTtl: 0
    }
  });

  if (!response.ok) {
    throw new Error(`Reddit feed request failed: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

async function readState(kv: KVNamespace): Promise<AlertState | null> {
  const rawState = await kv.get(STATE_KEY);
  if (!rawState) {
    return null;
  }

  try {
    const parsed = JSON.parse(rawState) as Partial<AlertState>;
    return {
      initializedAt: parsed.initializedAt ?? new Date(0).toISOString(),
      seenPostIds: Array.isArray(parsed.seenPostIds) ? parsed.seenPostIds : [],
      lastAlertedAt: parsed.lastAlertedAt
    };
  } catch {
    throw new Error("Stored alert state is not valid JSON");
  }
}

async function writeState(kv: KVNamespace, state: AlertState): Promise<void> {
  await kv.put(STATE_KEY, JSON.stringify(state));
}

async function sendNtfyAlert(env: Env, post: RedditPost): Promise<void> {
  const headers = new Headers({
    Title: sanitizeHeaderValue(env.NTFY_TITLE ?? "Reddit SSD Alert"),
    Tags: sanitizeHeaderValue(env.NTFY_TAGS ?? "computer,shopping"),
    Click: sanitizeHeaderUrl(post.dealUrl ?? post.commentsUrl)
  });

  if (env.NTFY_PRIORITY) {
    headers.set("Priority", sanitizeHeaderValue(env.NTFY_PRIORITY));
  }

  const response = await fetch(env.NTFY_TOPIC_URL ?? "", {
    method: "POST",
    headers,
    body: buildNtfyMessage(post)
  });

  if (!response.ok) {
    const responseBody = await response.text();
    throw new Error(
      `ntfy publish failed: ${response.status} ${response.statusText} ${responseBody}`
    );
  }
}

function parseEntry(value: unknown): RedditPost | null {
  const entry = asRecord(value);
  if (!entry) {
    return null;
  }

  const title = textValue(entry.title);
  const id = textValue(entry.id);
  const commentsUrl = extractLinkHref(entry.link);

  if (!title || !id || !commentsUrl) {
    return null;
  }

  return {
    id,
    title,
    commentsUrl,
    dealUrl: extractDealUrl(textValue(entry.content), commentsUrl),
    author: textValue(asRecord(entry.author)?.name),
    publishedAt: textValue(entry.published) || textValue(entry.updated),
    thumbnailUrl: extractThumbnailUrl(entry)
  };
}

function extractLinkHref(value: unknown): string {
  const links = asArray(value);

  for (const link of links) {
    if (typeof link === "string") {
      return link;
    }

    const record = asRecord(link);
    if (typeof record?.href === "string") {
      return decodeXmlEntities(record.href);
    }
  }

  return "";
}

function extractDealUrl(content: string, commentsUrl: string): string | undefined {
  if (!content) {
    return undefined;
  }

  const linkMatches = content.matchAll(/<a\s+href="([^"]+)"[^>]*>\[link\]<\/a>/gi);
  for (const match of linkMatches) {
    const href = decodeXmlEntities(match[1] ?? "");
    if (href && href !== commentsUrl && !href.includes("old.reddit.com/r/buildapcsales/comments")) {
      return href;
    }
  }

  return undefined;
}

function extractThumbnailUrl(entry: Record<string, unknown>): string | undefined {
  const thumbnail = asRecord(entry["media:thumbnail"]);
  const url = thumbnail?.url;

  return typeof url === "string" ? decodeXmlEntities(url) : undefined;
}

function buildNtfyMessage(post: RedditPost): string {
  const lines = [post.title];

  if (post.dealUrl) {
    lines.push(`Deal: ${post.dealUrl}`);
  }

  lines.push(`Comments: ${post.commentsUrl}`);

  if (post.author) {
    lines.push(`Posted by: ${post.author}`);
  }

  return lines.join("\n");
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }

  return Array.isArray(value) ? value : [value];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function textValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  const record = asRecord(value);
  if (typeof record?.text === "string") {
    return record.text;
  }

  return "";
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }

  return ["1", "true", "yes", "y", "on"].includes(value.toLowerCase());
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function sanitizeHeaderValue(value: string): string {
  return truncate(value.replace(/[\r\n]/g, " ").trim(), 200);
}

function sanitizeHeaderUrl(value: string): string {
  return value.replace(/[\r\n]/g, "").trim();
}

function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? `${value.slice(0, maxLength - 3)}...` : value;
}
