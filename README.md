# reddit-ssd-alert

A small Cloudflare Worker that checks SSD deal feeds on a cron schedule and sends new matches to ntfy.

```text
Deal Atom feeds -> Cloudflare Worker Cron -> Workers KV -> ntfy topic
```

The project is safe to keep public as long as secrets stay out of git. The ntfy topic URL is stored as a Wrangler secret, and local secret files are ignored.

## What It Does

- Runs every minute with a Cloudflare Workers Cron Trigger.
- Fetches SSD feeds for `r/buildapcsales`, `r/bapcsalescanada`, and RedFlagDeals Hot Deals.
- Stores recently seen deal post IDs in Workers KV.
- Sends an ntfy push notification for each new post.
- Bootstraps silently on the first run by default so you do not get spammed with old posts.
- Writes to KV only when state changes, which keeps the one-minute schedule inside the free KV write allowance for normal use.

## Setup

Install dependencies:

```bash
npm install
```

Log in to Cloudflare:

```bash
npx wrangler login
```

Create the KV namespace:

```bash
npx wrangler kv namespace create ALERT_STATE
```

Copy the generated namespace ID into `wrangler.jsonc`:

```jsonc
"kv_namespaces": [
  {
    "binding": "ALERT_STATE",
    "id": "paste-the-generated-id-here"
  }
]
```

Create a long random ntfy topic:

```bash
TOPIC="reddit-ssd-alert-$(openssl rand -hex 12)"
echo "$TOPIC"
```

In the ntfy app, subscribe to that topic on the `ntfy.sh` server. Then send yourself a test notification:

```bash
curl \
  -H "Title: SSD Deal Alert" \
  -d "ntfy is connected" \
  "https://ntfy.sh/$TOPIC"
```

If the notification appears on your phone, save the topic URL in your local secrets file:

```bash
cp .dev.vars.example .dev.vars
printf 'NTFY_TOPIC_URL="https://ntfy.sh/%s"\n' "$TOPIC" > .dev.vars
```

Deploy with that file uploaded as Worker secrets:

```bash
npm run deploy -- --secrets-file .dev.vars
```

Cloudflare may take several minutes to propagate new or changed cron triggers.

After the Worker exists, you can also rotate the ntfy topic later with:

```bash
npx wrangler secret put NTFY_TOPIC_URL
```

## Local Development

If you have not already created `.dev.vars`, copy the example local secrets file:

```bash
cp .dev.vars.example .dev.vars
```

Put your ntfy topic URL in `.dev.vars`, then start Wrangler:

```bash
npm run dev
```

Trigger the scheduled handler locally:

```bash
curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"
```

The normal Worker URL only exposes a small health response:

```bash
curl "http://localhost:8787/health"
```

## Configuration

Most settings live in `wrangler.jsonc`:

- `REDDIT_FEED_URLS`: comma-separated or newline-separated Reddit Atom/RSS URLs to monitor.
- `REDDIT_FEED_URL`: legacy single-feed override, used only when `REDDIT_FEED_URLS` is not set.
- `REDFLAGDEALS_FEED_URLS`: comma-separated or newline-separated RedFlagDeals Atom/RSS URLs to monitor.
- `REDFLAGDEALS_FEED_URL`: legacy single-feed RedFlagDeals override, used only when `REDFLAGDEALS_FEED_URLS` is not set.
- `SEEN_POST_LIMIT`: number of post IDs retained in KV.
- `MAX_ALERTS_PER_RUN`: maximum ntfy alerts sent during one cron run.
- `SEND_INITIAL_ALERTS`: set to `"true"` only if you want alerts for existing feed posts on first run.
- `NTFY_TITLE`: notification title.
- `NTFY_TAGS`: comma-separated ntfy tags.
- `NTFY_PRIORITY`: ntfy priority value.

The default Reddit feeds watch SSD-related flair in `r/buildapcsales` and storage-tagged posts in `r/bapcsalescanada`, such as `[SSD]`, `[SSD Enclosure]`, `[CPU+SSD]`, or `[GPU + SSD]`:

```text
https://old.reddit.com/r/buildapcsales/search.rss?q=flair%3A%22SSD%20-%20M.2%22%20OR%20flair%3A%22SSD%20-%20SATA%22%20OR%20flair%3ASSD&restrict_sr=1&sort=new
https://old.reddit.com/r/bapcsalescanada/search.rss?q=title%3ASSD%20OR%20title%3ANVMe%20OR%20title%3A%22M.2%22&restrict_sr=1&sort=new
```

The default RedFlagDeals feed watches Hot Deals and filters to storage-related deals while excluding likely whole-system posts such as laptops, desktops, and prebuilts:

```text
https://forums.redflagdeals.com/feed/forum/9
```

## Public Repo Safety

Safe to commit:

- `src/`
- `wrangler.jsonc`
- `package.json`
- `README.md`
- `.dev.vars.example`

Do not commit:

- `.dev.vars`
- `.env`
- `.wrangler/`
- ntfy topic URLs
- Cloudflare API tokens

The KV namespace ID in `wrangler.jsonc` is not a secret. It identifies the namespace but does not grant access by itself.
