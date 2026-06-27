import { XMLParser } from "fast-xml-parser";

export const DEFAULT_FEED_URL =
  "https://old.reddit.com/r/buildapcsales/search.rss?q=flair%3A%22SSD%20-%20M.2%22%20OR%20flair%3A%22SSD%20-%20SATA%22%20OR%20flair%3ASSD&restrict_sr=1&sort=new";
export const BAPCSALES_CANADA_FEED_URL =
  "https://old.reddit.com/r/bapcsalescanada/search.rss?q=title%3ASSD%20OR%20title%3ANVMe%20OR%20title%3A%22M.2%22&restrict_sr=1&sort=new";
export const DEFAULT_FEED_URLS = [DEFAULT_FEED_URL, BAPCSALES_CANADA_FEED_URL];
export const REDFLAGDEALS_HOT_DEALS_FEED_URL =
  "https://forums.redflagdeals.com/feed/forum/9";
export const DEFAULT_REDFLAGDEALS_FEED_URLS = [REDFLAGDEALS_HOT_DEALS_FEED_URL];

export const STATE_KEY = "reddit-ssd-alert-state";

export interface Env {
  ALERT_STATE: KVNamespace;
  NTFY_TOPIC_URL?: string;
  REDDIT_FEED_URL?: string;
  REDDIT_FEED_URLS?: string;
  REDFLAGDEALS_FEED_URL?: string;
  REDFLAGDEALS_FEED_URLS?: string;
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
  sourceName?: string;
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
  failedFeeds: number;
  bootstrapped: boolean;
  stateWritten: boolean;
}

interface AlertOptions {
  dryRun?: boolean;
  now?: Date;
}

export type FeedSourceKind = "reddit" | "redflagdeals";

export interface FeedSource {
  kind: FeedSourceKind;
  url: string;
}

interface FeedPostsResult {
  source: FeedSource;
  posts: RedditPost[];
}

interface FeedFailure {
  kind: FeedSourceKind;
  feedUrl: string;
  error: string;
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
  const feedSources = getConfiguredFeedSources(env);
  const [state, feedFetchResult] = await Promise.all([
    readState(env.ALERT_STATE),
    fetchPostsFromSources(feedSources)
  ]);
  const { successfulFeeds, failedFeeds } = feedFetchResult;

  if (successfulFeeds.length === 0) {
    throw new Error(`All deal feed requests failed: ${formatFeedFailures(failedFeeds)}`);
  }

  if (failedFeeds.length > 0) {
    console.warn("reddit-ssd-alert skipped failed feeds", failedFeeds);
  }

  const posts = mergeRedditPosts(
    successfulFeeds.flatMap((feedResult) => feedResult.posts)
  );
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
  const partialBootstrap = firstRun && !sendInitialAlerts && failedFeeds.length > 0;

  for (const post of alertablePosts) {
    if (!options.dryRun) {
      await sendNtfyAlert(env, post);
    }
  }

  const shouldWriteState = !partialBootstrap && (firstRun || newPosts.length > 0);
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
    failedFeeds: failedFeeds.length,
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

export function parseRedflagDealsAtomFeed(xml: string): RedditPost[] {
  const parsed = parser.parse(xml) as Record<string, unknown>;
  const feed = asRecord(parsed.feed);
  const entries = asArray(feed?.entry);

  return entries
    .map(parseRedflagDealsEntry)
    .filter((post): post is RedditPost => Boolean(post));
}

export function getConfiguredFeedSources(
  env: Pick<
    Env,
    | "REDDIT_FEED_URL"
    | "REDDIT_FEED_URLS"
    | "REDFLAGDEALS_FEED_URL"
    | "REDFLAGDEALS_FEED_URLS"
  >
): FeedSource[] {
  return [
    ...getConfiguredFeedUrls(env).map((url) => ({ kind: "reddit" as const, url })),
    ...getConfiguredRedflagDealsFeedUrls(env).map((url) => ({
      kind: "redflagdeals" as const,
      url
    }))
  ];
}

export function getConfiguredFeedUrls(
  env: Pick<Env, "REDDIT_FEED_URL" | "REDDIT_FEED_URLS">
): string[] {
  const configured = env.REDDIT_FEED_URLS ?? env.REDDIT_FEED_URL;
  if (!configured) {
    return DEFAULT_FEED_URLS;
  }

  const feedUrls = configured
    .split(/[\n,]+/)
    .map((feedUrl) => feedUrl.trim())
    .filter(Boolean);

  return feedUrls.length > 0 ? feedUrls : DEFAULT_FEED_URLS;
}

export function getConfiguredRedflagDealsFeedUrls(
  env: Pick<Env, "REDFLAGDEALS_FEED_URL" | "REDFLAGDEALS_FEED_URLS">
): string[] {
  const configured = env.REDFLAGDEALS_FEED_URLS ?? env.REDFLAGDEALS_FEED_URL;
  if (!configured) {
    return [];
  }

  const feedUrls = configured
    .split(/[\n,]+/)
    .map((feedUrl) => feedUrl.trim())
    .filter(Boolean);

  return feedUrls.length > 0 ? feedUrls : DEFAULT_REDFLAGDEALS_FEED_URLS;
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

async function fetchPostsFromSources(
  feedSources: FeedSource[]
): Promise<{ successfulFeeds: FeedPostsResult[]; failedFeeds: FeedFailure[] }> {
  const results = await Promise.all(
    feedSources.map(async (source) => {
      try {
        const xml = await fetchFeed(source.url);
        const posts = parseFeedForSource(source, xml);

        return { ok: true as const, source, posts };
      } catch (error) {
        return { ok: false as const, source, error: errorMessage(error) };
      }
    })
  );

  return {
    successfulFeeds: results.flatMap((result) =>
      result.ok ? [{ source: result.source, posts: result.posts }] : []
    ),
    failedFeeds: results.flatMap((result) =>
      result.ok
        ? []
        : [{ kind: result.source.kind, feedUrl: result.source.url, error: result.error }]
    )
  };
}

function parseFeedForSource(source: FeedSource, xml: string): RedditPost[] {
  if (source.kind === "redflagdeals") {
    return parseRedflagDealsAtomFeed(xml);
  }

  return parseRedditAtomFeed(xml).filter((post) =>
    shouldIncludePostFromFeed(source.url, post)
  );
}

function mergeRedditPosts(posts: RedditPost[]): RedditPost[] {
  const merged = new Map<string, RedditPost>();

  for (const post of posts) {
    if (!merged.has(post.id)) {
      merged.set(post.id, post);
    }
  }

  return [...merged.values()].sort(comparePostsByPublishedAtDesc);
}

function comparePostsByPublishedAtDesc(a: RedditPost, b: RedditPost): number {
  return publishedTime(b) - publishedTime(a);
}

function publishedTime(post: RedditPost): number {
  if (!post.publishedAt) {
    return 0;
  }

  const time = Date.parse(post.publishedAt);
  return Number.isNaN(time) ? 0 : time;
}

function shouldIncludePostFromFeed(feedUrl: string, post: RedditPost): boolean {
  if (!isBapcSalesCanadaFeed(feedUrl)) {
    return true;
  }

  return hasStorageTitleTag(post.title);
}

function isBapcSalesCanadaFeed(feedUrl: string): boolean {
  try {
    return new URL(feedUrl).pathname.toLowerCase().includes("/r/bapcsalescanada/");
  } catch {
    return feedUrl.toLowerCase().includes("/r/bapcsalescanada/");
  }
}

function hasStorageTitleTag(title: string): boolean {
  const tag = title.match(/^\s*\[([^\]]+)\]/)?.[1] ?? "";
  return /\b(ssd|nvme)\b|m\.2/i.test(tag);
}

function isRedflagDealsStorageCandidate(
  title: string,
  content: string,
  dealUrl: string | undefined
): boolean {
  if (hasWholeSystemDealTerm(title)) {
    return false;
  }

  return (
    hasStorageDealTerm(title) ||
    hasStorageDealTerm(dealUrl ?? "") ||
    hasStorageDealTerm(stripHtml(content))
  );
}

function hasStorageDealTerm(value: string): boolean {
  return /\b(ssd|nvme)\b|\bm\.2\b|\bsolid[-\s]?state\b/i.test(value);
}

function hasWholeSystemDealTerm(value: string): boolean {
  return /\b(laptop|notebook|chromebook|desktop|prebuilt|gaming pc|mini pc|workstation|tablet|handheld|console)\b/i.test(
    value
  );
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

function formatFeedFailures(failures: FeedFailure[]): string {
  return failures
    .map((failure) => `${failure.kind} ${failure.feedUrl}: ${failure.error}`)
    .join("; ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
    throw new Error(`Deal feed request failed: ${response.status} ${response.statusText}`);
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
    Title: sanitizeHeaderValue(env.NTFY_TITLE ?? "SSD Deal Alert"),
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

function parseRedflagDealsEntry(value: unknown): RedditPost | null {
  const entry = asRecord(value);
  if (!entry) {
    return null;
  }

  const title = textValue(entry.title);
  const entryId = textValue(entry.id);
  const linkUrl = extractLinkHref(entry.link) || entryId;
  const commentsUrl = normalizeRedflagDealsThreadUrl(linkUrl);

  if (!title || !commentsUrl) {
    return null;
  }

  const content = textValue(entry.content);
  const threadId = extractRedflagDealsThreadId(commentsUrl);
  const dealUrl = extractFirstExternalUrl(content, commentsUrl);

  if (!isRedflagDealsStorageCandidate(title, content, dealUrl)) {
    return null;
  }

  return {
    id: threadId ? `redflagdeals:${threadId}` : `redflagdeals:${commentsUrl}`,
    title,
    commentsUrl,
    dealUrl,
    author: textValue(asRecord(entry.author)?.name),
    publishedAt: textValue(entry.published) || textValue(entry.updated),
    sourceName: "RedFlagDeals"
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

function normalizeRedflagDealsThreadUrl(value: string): string {
  const decoded = decodeXmlEntities(value);

  try {
    const url = new URL(decoded);
    const threadId = url.searchParams.get("t") ?? extractRedflagDealsThreadId(decoded);

    if (threadId) {
      return `https://forums.redflagdeals.com/viewtopic.php?t=${threadId}`;
    }

    url.hash = "";
    url.searchParams.delete("p");
    return url.toString();
  } catch {
    return decoded.replace(/([?&])p=\d+/, "").replace(/#.*$/, "");
  }
}

function extractRedflagDealsThreadId(value: string): string | undefined {
  try {
    const url = new URL(decodeXmlEntities(value));
    const threadId = url.searchParams.get("t");
    if (threadId) {
      return threadId;
    }
  } catch {
    // Fall through to the path-based format below.
  }

  return value.match(/-(\d+)\/?(?:[?#].*)?$/)?.[1];
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

function extractFirstExternalUrl(content: string, sourceUrl: string): string | undefined {
  if (!content) {
    return undefined;
  }

  const linkMatches = content.matchAll(/<a\s+[^>]*href="([^"]+)"[^>]*>/gi);
  for (const match of linkMatches) {
    const href = decodeXmlEntities(match[1] ?? "").trim();
    if (href && isExternalHttpUrl(href, sourceUrl)) {
      return href;
    }
  }

  return undefined;
}

function isExternalHttpUrl(value: string, sourceUrl: string): boolean {
  try {
    const url = new URL(value);
    const source = new URL(sourceUrl);

    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      !sameRegistrableHost(url.hostname, source.hostname)
    );
  } catch {
    return false;
  }
}

function sameRegistrableHost(hostname: string, otherHostname: string): boolean {
  const host = hostname.toLowerCase();
  const otherHost = otherHostname.toLowerCase();

  return (
    host === otherHost ||
    host.endsWith(`.${otherHost}`) ||
    otherHost.endsWith(`.${host}`) ||
    (host.endsWith(".redflagdeals.com") && otherHost.endsWith(".redflagdeals.com"))
  );
}

function extractThumbnailUrl(entry: Record<string, unknown>): string | undefined {
  const thumbnail = asRecord(entry["media:thumbnail"]);
  const url = thumbnail?.url;

  return typeof url === "string" ? decodeXmlEntities(url) : undefined;
}

function buildNtfyMessage(post: RedditPost): string {
  const lines = [post.title];

  if (post.sourceName) {
    lines.push(`Source: ${post.sourceName}`);
  }

  if (post.dealUrl) {
    lines.push(`Deal: ${post.dealUrl}`);
  }

  const discussionLabel = post.sourceName === "RedFlagDeals" ? "Thread" : "Comments";
  lines.push(`${discussionLabel}: ${post.commentsUrl}`);

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
