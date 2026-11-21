# Shams Support Survey

Anonymous public support survey for Shams-ur-Rehman, Ward 7 – Kashrote Yadgaar. Visitors provide their name and choose Yes or No; administrators see a complete report with names, responses, and timestamps.

## Features

- Single-use session tokens, honeypot field, minimum-fill delay, per-IP rate limits, and origin checks
- One response per browser profile: a signed, HttpOnly, SameSite cookie (Secure in production); only its SHA-256 hash is stored
- Atomic device dedupe index in `data/device-index/` blocks simultaneous duplicate requests
- Persistent sessions, rate limits, and admin logins in `data/state.json` (survive restarts)
- Required name field with a Yes/No response and an optional review/comment
- Replaceable candidate photo and election symbol placeholders in `public/assets/`
- Admin dashboard at `/admin` with totals, a per-respondent report, date range, and CSV/NDJSON downloads
- Security headers, strict CSP, responsive layout, reduced-motion support
- 22 automated tests covering the API, device dedupe, validation, persistence, and frontend logic

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

## Admin

Visit `/admin`, enter `ADMIN_TOKEN`, and sign in. Admin cookies are `HttpOnly`, `SameSite=Strict`, and valid for 12 hours. Direct export URLs:

- `GET /api/results/export?format=csv`
- `GET /api/results/export?format=ndjson`

## HTTP API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | Health check |
| `GET` | `/api/survey/status` | Returns `{ submitted, answer }` for the current browser cookie (sets it if missing) |
| `POST` | `/api/responses` | Submit `{ name, answer, token, website }` with the device cookie; `name` is required and `answer` is `yes` or `no` |
| `POST` | `/api/admin/login` | Submit `{ token }`, sets admin cookie |
| `GET` | `/api/admin/session` | Returns `{ authenticated }` |
| `POST` | `/api/admin/logout` | Clears admin session |
| `GET` | `/api/results` | Aggregated counts plus a per-respondent report (admin only) |
| `GET` | `/api/results/export` | Full anonymized records (admin only) |

## Data

- `data/responses.ndjson` — one JSON object per line: `id`, `name`, `answer`, `deviceHash`, `submittedAt`. No IP addresses or raw device cookies are stored.
- `data/device-index/` — one empty file per submitted device hash; exclusive creation is the unique index that prevents concurrent duplicates.
- `data/state.json` — hashed client keys, device-token signing secret, active sessions, rate-limit buckets, and admin sessions. Keep this file private.

Existing responses without `deviceHash` are preserved as-is; they simply cannot be matched to a browser cookie and need no migration. The admin report maps legacy `voterName`, `respondentName`, `fullName`, or `submittedBy` values into the Name column. Records with no stored name are shown as `Not provided`; their original data is left untouched.

## Deployment

Docker:

```sh
docker compose up --build -d
```

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
