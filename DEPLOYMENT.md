# Deployment

## Where it runs

| | |
|---|---|
| Host | Render (web service, Oregon, `starter` plan) |
| Service | `slakedesign-rag` — `srv-d762g7khg0os73begt40` |
| URL | https://slakedesign-rag.onrender.com |
| Repo / branch | `Slake-Design/slakedesign-rag` — `main` |
| Auto-deploy | **on**, triggered per commit to `main` |
| Consumed by | `slakedesign.com/demo/rag` — the browser calls `/query` **directly**, with no proxy function in between |

## Build and start commands

```
Build:  npm install --global npm@11.6.2 && npm ci --include=dev && npm run build && npm prune --omit=dev
Start:  npm start
```

Every part of that build command is load-bearing. It was arrived at by two
failed production deploys, so do not simplify it without reading this:

- **`npm install --global npm@11.6.2`** — `package-lock.json` was written by
  npm 11.6.2. A different npm rejects the tree over optional transitives of
  `@napi-rs/wasm-runtime` (pulled in by vitest via rolldown) and fails with
  `Missing: @emnapi/runtime@1.11.3 from lock file`. This is the same pin
  `.github/workflows/test.yml` applies, for the same reason.
- **`npm ci --include=dev`** — Render sets `NODE_ENV=production`, which makes
  npm set `omit=dev` and strip `devDependencies`. `typescript` lives there and
  is exactly what `tsc` needs. Without the flag the build fails with dozens of
  missing-module errors. `npm ci` rather than `npm install` so the build fails
  on lockfile drift instead of silently resolving a different tree.
- **`npm run build`** — this repo emitted no build artifact until the
  TypeScript port. `npm start` runs `node dist/index.js`; without this step
  there is no `dist/`.
- **`npm prune --omit=dev`** — drops the build-only dependencies from the
  running image after compilation.

Dropping `NODE_ENV=production` instead of adding `--include=dev` also produces a
working build, but it is the wrong trade: the variable is what keeps
development-only behaviour out of the running service.

## Environment variables

| Variable | Required | Default | Notes |
|---|:---:|---|---|
| `GEMINI_API_KEY` | **yes** | — | Service throws at boot without it, deliberately: a misconfigured deploy should fail fast rather than serve broken retrieval. |
| `PORT` | no | `3001` | Set by Render (`10000` in production). |
| `GEMINI_MODEL` | no | `gemini-2.5-flash-lite` | |
| `GEMINI_EMBEDDING_MODEL` | no | `models/gemini-embedding-001` | Changing this invalidates the corpus. See the dimension gate in `src/repositories/document.repository.ts`. |
| `MAX_CONTEXT_TOKENS` | no | `3000` | |
| `LOG_LEVEL` | no | `info` | |
| `TRUST_PROXY_HOPS` | no | `2` | Measured against the deployed proxy chain — see the comment in `index.ts` before changing. |
| `CORPUS_PATH` | no | `<cwd>/src/data/documents.json` | Resolved from the working directory, **not** `__dirname`: the compiled output lives in `dist/` and the 25 MB corpus does not. |

## Deploying

Auto-deploy handles the normal case: merge to `main`, Render builds and swaps.

Manually, with the Render CLI:

```bash
render deploys create srv-d762g7khg0os73begt40 --confirm --wait
```

**Render runs both instances briefly during a swap.** The old one keeps serving
until the new one is healthy, so for roughly 30 seconds after a deploy reports
`live`, a request may still be answered by the previous version. Verify with a
signal only the new build produces rather than trusting the deploy status —
during this rollout the `x-correlation-id` response header served that purpose.

## Rollback

1. **Preferred — redeploy the last good version.** Render's dashboard lists
   prior deploys with a rollback action; the CLI equivalent is
   `render deploys create <srv-id> --commit <sha>`.
2. **Revert the commit.** `git revert -m 1 <merge-sha>` on `main`, push, and
   let auto-deploy carry it. Slower, but it keeps `main` and production
   identical, which matters if the bad change is also wrong in the repo.
3. **Last resort — disable the demo link** on `slakedesign.com/demo` so the page
   does not advertise a broken service while it is being fixed.

A failed build is self-rollbacking: Render keeps the previous version live and
never routes traffic to a build that did not start. This was exercised for real
— two deploys failed with `Cannot find module '.../index.js'` and the previous
version kept serving throughout.

## Known behavioural changes

Introduced by the P5/P7 work deployed 2026-08-28:

- **Questions scoring between `0.48` and `0.62` are now refused.**
  `MATCH_THRESHOLD` was raised after measuring that the old value sat *below*
  the noise band — see the calibration section in `README.md`. Realistic
  payments questions score `0.706`–`0.816` and are unaffected.
- **A question that retrieves nothing is refused without calling the model.**
  It returns `NO_CONTEXT_TEXT` and emits no `sources`. The demo page already
  handled a sources-less response (the out-of-domain path), so no frontend
  change was needed.
- **Request bodies are validated with a strict Zod schema.** Any field other
  than `question` is rejected with a 400. The demo page sends exactly
  `{ question }`.
- **Logs are structured JSON** (Pino) rather than `console.log`, and carry an
  `x-correlation-id` accepted from the request or generated per request.

## Smoke test after deploy

```bash
# 1. New code is actually serving (not the draining old instance)
curl -sD - -o /dev/null https://slakedesign-rag.onrender.com/health | grep -i x-correlation-id

# 2. A real question answers with sources
curl -s -X POST https://slakedesign-rag.onrender.com/query \
  -H 'Content-Type: application/json' \
  -d '{"question":"How do I issue a refund for a charge?"}' | grep -c '"sources"'

# 3. Noise is refused by the code gate, not the prompt
curl -s -X POST https://slakedesign-rag.onrender.com/query \
  -H 'Content-Type: application/json' \
  -d '{"question":"zxqv plorbnat weffle grimsby"}' | grep -c 'could not find anything'
```

Then confirm the page itself loads and streams: https://slakedesign.com/demo/rag
