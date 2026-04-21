# zkAPI docs

Fumadocs-powered documentation site for zkAPI. Built on Next.js 16 + MDX.

## Local development

```bash
pnpm install
pnpm dev      # http://localhost:3000
pnpm build    # production build
pnpm start    # serve the production build
pnpm types:check
```

## Content

Documentation pages live in `content/docs/`. Each page is MDX with frontmatter:

```mdx
---
title: Getting Started
description: Short tagline shown in nav + OG tags
---

Markdown/MDX body…
```

Ordering comes from `content/docs/meta.json` (and any nested `meta.json`
files). Edit those files to reorder the sidebar.

Shared strings (app name, GitHub repo, route paths) live in
`src/lib/shared.ts`. Top-nav links live in `src/lib/layout.shared.tsx`.

## Deploying to Vercel

This app lives in a subdirectory (`docs-site/`) of the zkAPI monorepo. Vercel
needs the **Root Directory** set accordingly.

### Option 1 — Vercel CLI (fastest)

```bash
npm i -g vercel          # or: pnpm add -g vercel
cd docs-site
vercel                   # first-time: creates project, links Git
vercel --prod            # deploy to production
```

When prompted for "In which directory is your code located?" accept the
default (`./`) since you're already inside `docs-site/`.

### Option 2 — Git integration (recommended for teams)

1. Push the repo to GitHub.
2. Go to <https://vercel.com/new> and import the repo.
3. In the import screen, set **Root Directory** to `docs-site`.
4. Framework preset auto-detects as **Next.js**; leave build/install commands
   as-is (Vercel uses `pnpm install` + `pnpm build`).
5. Deploy. Every push to `main` deploys to production; every PR gets a preview URL.

### Environment

No env vars are required for the default static site. If you later add
[Orama Cloud search](https://fumadocs.dev/docs/headless/search/orama-cloud),
add `NEXT_PUBLIC_ORAMA_*` vars in the Vercel project settings.

### Custom domain

In the Vercel project → Settings → Domains, add e.g. `docs.zkapi.xyz`. Add
the CNAME record your registrar shows.

## Routes

| Route | Description |
|---|---|
| `/` | Landing page |
| `/docs` | Docs index |
| `/docs/[…slug]` | Individual pages |
| `/api/search` | Orama search endpoint |
| `/og/docs/[…slug]/image.png` | Per-page OG image |
| `/llms.txt`, `/llms-full.txt` | LLM-friendly content dumps |
