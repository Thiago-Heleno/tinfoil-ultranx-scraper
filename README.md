# tinfoil-ultranx-scraper

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/4oX_r3?referralCode=LfY6oV&utm_medium=integration&utm_source=template&utm_campaign=generic)

Bun server that scrapes titles from not.ultranx.ru and exposes JSON plus a Tinfoil-friendly index.

## Deploy to Railway

1. Click the "Deploy on Railway" button above
2. Connect your GitHub account if prompted
3. After deployment, go to **Variables** tab and add:
   - `AUTH_TOKEN` = Your JWT token from not.ultranx.ru
4. Redeploy to apply the variable
5. Add to Tinfoil: `https://YOUR-APP.up.railway.app/tinfoil.json`

## Requirements

- Bun

## Install

```bash
bun install
```

## Run

```bash
bun run dev
```

```bash
bun run start
```

## Endpoints

- `GET /api/titles?p=1&pages=1&s=&sb=release_date&so=desc`
- `GET /api/game/:id`
- `GET /download/:id/:type` (`type` = `base|update|dlc|full`)
- `GET /shop?p=1` (also works with trailing slash)
- `GET /tinfoil.json`
- `GET /health`

## Environment

- `PORT` (default: 3000)
- `CACHE_TTL_MS` (default: 300000)
- `MAX_PAGES` (default: 10)
- `BATCH_SIZE` (default: 5)
- `FETCH_TIMEOUT_MS` (default: 15000)
- `TINFOIL_MIN_VERSION` (default: 17)
- `AUTH_TOKEN` or `ACCESS_TOKEN` (required for `/download/*` and actual installs in Tinfoil; accepts raw JWT, `auth_token=...`, or `Bearer ...`)
- `DEVICE_ID` (optional; needed only if upstream returns a `DeviceID` auth challenge)
- `DOWNLOAD_REDIRECT_CACHE_TTL_MS` (default: 0; set >0 to cache resolved download redirects)
- `DOWNLOAD_PROXY` (default: `false`; use `true` only if direct mirror redirects fail in Tinfoil)
- `TINFOIL_FLAT_ALL` (default: `true`; makes `/tinfoil.json` return all titles without page directories)

## Notes

- `/tinfoil.json` returns a directory listing suitable for Tinfoil. `/shop` serves a simple HTML list.
- Files are proxied via `/download/:id/:type` and redirected to upstream mirrors.
- If `AUTH_TOKEN` is missing, `/tinfoil.json` still renders but download links will fail.
