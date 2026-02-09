# tinfoil-ultranx-scraper

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/template/from?repoUrl=https%3A%2F%2Fgithub.com%2FThiago-Heleno%2Ftinfoil-ultranx-scraper)

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
- `GET /shop?p=1` (also works with trailing slash)
- `GET /tinfoil.json`

## Environment

- `PORT` (default: 3000)
- `CACHE_TTL_MS` (default: 300000)
- `MAX_PAGES` (default: 10)
- `SHOP_MAX_PAGES` (default: 10)

## Notes

- `/tinfoil.json` returns a directory listing suitable for Tinfoil. `/shop` serves a simple HTML list.
- This server only lists scraped metadata and does not host installable files.
