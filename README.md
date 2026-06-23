# reddit-ssd-alert

A small Cloudflare Worker that checks the `r/buildapcsales` SSD search feed on a cron schedule and sends new matches to ntfy.

```text
Reddit Atom feed -> Cloudflare Worker Cron -> Workers KV -> ntfy topic
```

The project is safe to keep public as long as secrets stay out of git. The ntfy topic URL is stored as a Wrangler secret, and local secret files are ignored.

## What It Does

- Runs every minute with a Cloudflare Workers Cron Trigger.
- Fetches a flair-based `r/buildapcsales` SSD feed from `old.reddit.com`.
- Stores recently seen Reddit post IDs in Workers KV.
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
  -H "Title: Reddit SSD Alert" \
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

- `REDDIT_FEED_URL`: Reddit Atom/RSS URL to monitor.
- `SEEN_POST_LIMIT`: number of post IDs retained in KV.
- `MAX_ALERTS_PER_RUN`: maximum ntfy alerts sent during one cron run.
- `SEND_INITIAL_ALERTS`: set to `"true"` only if you want alerts for existing feed posts on first run.
- `NTFY_TITLE`: notification title.
- `NTFY_TAGS`: comma-separated ntfy tags.
- `NTFY_PRIORITY`: ntfy priority value.

The default feed watches SSD-related flair in `r/buildapcsales`:

```text
https://old.reddit.com/r/buildapcsales/search.rss?q=flair%3A%22SSD%20-%20M.2%22%20OR%20flair%3A%22SSD%20-%20SATA%22%20OR%20flair%3ASSD&restrict_sr=1&sort=new
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
