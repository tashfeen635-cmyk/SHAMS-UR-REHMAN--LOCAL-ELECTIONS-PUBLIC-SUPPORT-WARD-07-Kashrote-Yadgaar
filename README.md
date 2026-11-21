# Shams Support Survey

Anonymous public support survey for Shams-ur-Rehman, Ward 7 – Kashrote Yadgaar. Visitors provide their name and choose Yes or No; administrators see a complete report with names, responses, and timestamps.

## Features

- Single-use session tokens, honeypot field, minimum-fill delay, per-IP rate limits, and origin checks
- One response per browser profile: a signed, HttpOnly, SameSite cookie (Secure in production); only its SHA-256 hash is stored
- Atomic device dedupe index in `data/device-index/` blocks simultaneous duplicate requests
- Persistent sessions, rate limits, and admin logins in `data/state.json` locally, or in MongoDB Atlas on Vercel
- Required name field with a Yes/No response and an optional review/comment
- Replaceable candidate photo and election symbol placeholders in `public/assets/`
- Admin dashboard at `/admin` with totals, a per-respondent report, date range, and CSV/NDJSON downloads
- Security headers, strict CSP, responsive layout, reduced-motion support
- 26 automated tests covering the API, device dedupe, validation, persistence, frontend logic, and Vercel error handling

## Quick start

Node.js 20 or newer is required.

```sh
npm ci
npm run dev
```

Open `http://localhost:3000`. To enable the admin area, set `ADMIN_TOKEN` before starting:

```sh
ADMIN_TOKEN=$(openssl rand -hex 32) npm run dev
```

Production build:

```sh
npm run build
npm start
npm test
npm run check
```

## Local environment file

For local development you can copy `.env.example` to `.env` and fill in the values you need. Real `.env` files are ignored by Git; never commit secrets or paste them into source files.

```sh
cp .env.example .env
npm run env:check
```

`npm run env:check` validates `MONGODB_URI`, `DEVICE_SECRET`, and `ADMIN_TOKEN`, then connects to MongoDB and reports the current response count. It does not print secret values. Vercel does not use `.env`; add the same variables in the Vercel dashboard.

## Assets

Replace `public/assets/candidate-photo.jpg` and `public/assets/election-symbol.jpg` with the official assets, keeping the same filenames. Run `npm run build` afterwards so `dist/` picks up the replacements. The bundled portrait is a resized 800×800 copy of the supplied image.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | Bind address |
| `DATA_DIR` | `./data` | Directory for responses and state |
| `DATA_FILE` | `$DATA_DIR/responses.ndjson` | Response log path |
| `STATE_FILE` | `$DATA_DIR/state.json` | Session/rate-limit/admin state path |
| `DEVICE_INDEX_DIR` | `$DATA_DIR/device-index` | Unique device-hash index directory |
| `ADMIN_TOKEN` | unset | Enables `/admin` and the results API when set |
| `COOKIE_SECURE` | auto | `Secure` flag: on by default in production; set `1` to force on, `0` for local HTTP testing |
| `TRUST_PROXY` | `0` | Set to `1` only behind a trusted reverse proxy |
| `NODE_ENV` | unset | `production` serves files from `dist/` |
| `MONGODB_URI` | unset | Enables MongoDB storage in Vercel functions (required there) |
| `MONGODB_DB` | `shams_survey` | MongoDB database name |
| `DEVICE_SECRET` | unset | Long random secret for signed device cookies on Vercel (required there) |

## Admin

Visit `/admin`, enter `ADMIN_TOKEN`, and sign in. Admin cookies are `HttpOnly`, `SameSite=Strict`, and valid for 12 hours. Direct export URLs:

- `GET /api/results/export?format=csv`
- `GET /api/results/export?format=ndjson`

## HTTP API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Health check |
| `GET` | `/api/survey/session` | Creates a survey session token for statically hosted pages (sets the device cookie) |
| `GET` | `/api/survey/status` | Returns `{ submitted, answer, token }` for the current browser cookie (sets it if missing) |
| `POST` | `/api/responses` | Submit `{ name, answer, token, website, comment }` with the device cookie; `name` is required and `answer` is `yes` or `no` |
| `POST` | `/api/admin/login` | Submit `{ token }`, sets admin cookie |
| `GET` | `/api/admin/session` | Returns `{ authenticated }` |
| `POST` | `/api/admin/logout` | Clears admin session |
| `GET` | `/api/results` | Aggregated counts plus a per-respondent report (admin only) |
| `GET` | `/api/results/export` | Full anonymized records (admin only) |

## Data

- `data/responses.ndjson` — one JSON object per line: `id`, `name`, `answer`, `deviceHash`, `submittedAt`. No IP addresses or raw device cookies are stored.
- `data/device-index/` — one empty file per submitted device hash; exclusive creation is the unique index that prevents concurrent duplicates.
- `data/state.json` — hashed client keys, device-token signing secret, active sessions, rate-limit buckets, and admin sessions. Keep this file private.

On Vercel, the same data lives in MongoDB collections: `responses` (unique `deviceHash`), `sessions`, `rate_limits`, and `admin_sessions`.

Existing responses without `deviceHash` are preserved as-is; they simply cannot be matched to a browser cookie and need no migration. The admin report maps legacy `voterName`, `respondentName`, `fullName`, or `submittedBy` values into the Name column. Records with no stored name are shown as `Not provided`; their original data is left untouched.

## Deployment

Docker:

```sh
docker compose up --build -d
```

Vercel + MongoDB Atlas:

1. Push this repository to GitHub, then import it in Vercel.
2. Keep the detected build command `npm run build` and output directory `dist` from `vercel.json`.
3. Create a MongoDB Atlas cluster, allow access from `0.0.0.0/0` (Vercel serverless egress is not a fixed IP), and create a database user.
4. Add these Vercel project environment variables:
   - `MONGODB_URI` — Atlas connection string with the database user password
   - `MONGODB_DB` — e.g. `shams_survey`
   - `DEVICE_SECRET` — a long random permanent secret (generate with `openssl rand -hex 32`)
   - `ADMIN_TOKEN` — a separate long random admin secret
   - `TRUST_PROXY=1`
5. Deploy. `api/` serverless functions store responses, sessions, rate limits, and admin sessions in MongoDB; `dist/` serves the public page and admin page. The frontend gets its session token from `/api/survey/status`, with `/api/survey/session` as a fallback.
6. Do not change `DEVICE_SECRET` after launch unless you want every existing browser device token to become invalid.
7. Before deploying, you can place the same values in a local `.env` and run `npm run env:check` to verify Atlas connectivity without printing secrets.
8. After deploying, `GET /api/health` checks only that the function runtime works. `GET /api/health?db=1` also connects to MongoDB and returns `{ ok: true, db: true, responses: <count> }`. API failures now include a safe `code` such as `CONFIG_ERROR`, `MONGO_CONNECT_ERROR`, `MONGO_INDEX_ERROR`, `SESSION_STORAGE_ERROR`, or `STATUS_READ_ERROR`.

Systemd: copy `server.mjs`, `lib/`, `public/`, `dist/`, and `package.json` to `/opt/shams-survey`, install `deploy/shams-survey.service`, and create `/etc/shams-survey/env` with mode `0600`:

```ini
NODE_ENV=production
HOST=127.0.0.1
PORT=3000
DATA_DIR=/var/lib/shams-survey
ADMIN_TOKEN=<long-random-value>
COOKIE_SECURE=1
TRUST_PROXY=1
```

An nginx TLS reverse-proxy example is in `deploy/nginx.conf.example`. When proxying, set `TRUST_PROXY=1` and `COOKIE_SECURE=1`, and keep `HOST` bound to loopback or protected by the firewall.

## One-response limitation

This identifies a **browser profile**, not a person or physical device. Clearing cookies/site data, using a different browser, or using another device allows another submission. It is not absolute one-person-one-vote enforcement. No fingerprinting or personal identifiers are collected.

## Security notes

- Use a long random `ADMIN_TOKEN`; admin access is disabled entirely when it is unset.
- Serve over HTTPS in production and never enable `TRUST_PROXY` unless every proxy hop is trusted.
- Restrict filesystem permissions on `DATA_DIR` and back up `responses.ndjson`, `state.json`, and `device-index/` together so hashes and the signing secret stay in sync.
- Failed response writes restore the session, so a transient disk error does not lose a vote.
