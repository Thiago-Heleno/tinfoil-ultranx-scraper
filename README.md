# tinfoil-ultranx-scraper

[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template?template=https://github.com/Thiago-Heleno/tinfoil-ultranx-scraper&envs=AUTH_TOKEN&AUTH_TOKENDesc=JWT%20token%20from%20not.ultranx.ru)

Bun server that scrapes titles from not.ultranx.ru and exposes JSON plus a Tinfoil-friendly index.

## Deploy to Railway

1. Push this repo to your GitHub
2. Update the deploy button URL in this README with your GitHub username
3. Click the "Deploy on Railway" button
4. Set the `AUTH_TOKEN` environment variable (your JWT from not.ultranx.ru)
5. Deploy and get your public URL
6. Add to Tinfoil: `https://YOUR-APP.up.railway.app/tinfoil.json`

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
