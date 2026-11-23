# SmartCart

SmartCart is an AI grocery shopping agent for Israeli supermarkets. A customer describes a shopping list or a meal in English, Hebrew or Arabic. SmartCart finds real products in a MongoDB Atlas catalog, checks each product against the customer's mandatory requirements, works out whole-package quantities and prices, compares complete single-store baskets, and saves the cart. The customer can then change the cart through chat ("make it cheaper", "only Tnuva milk", "remove eggs") or through the cart controls, by typing or by speaking: SmartCart listens and answers out loud, and every spoken exchange also appears as text.

The catalog holds 31,330 offers from Shufersal store 413 and Rami Levy store 039. Prices are catalog snapshots from 16–17 November 2026. SmartCart has no live stock, promotions, delivery fees, checkout or payment.

## Quick start

Requirements: Node.js 22.6 or later and a MongoDB Atlas cluster with the catalog imported (see [MongoDB setup](#mongodb-setup)). In PowerShell, use `npm.cmd` if script execution blocks `npm`.

```powershell
npm ci
copy .env.example .env          # then fill in MONGODB_URI and GEMINI_API_KEY
npm run db:indexes              # idempotent
npm run dev                     # http://localhost:3000
```

For a production build:

```powershell
npm run build
npm start
```

`GET /api/health` reports the database connection, the product count, the stores and whether Gemini is configured. It never returns credentials.

## Configuration

All variables are read on the server. None reach the browser.

| Variable | Required | Purpose |
| --- | --- | --- |
| `MONGODB_URI` | yes | Atlas connection string. |
| `MONGODB_DB_NAME` | no (`smartcart`) | Application database. |
| `GEMINI_API_KEY` | yes, for the agent | Google Gemini API key. |
| `GEMINI_MODEL` | no (`gemini-3.1-flash-lite`) | The main agent model: a `generateContent` model with function calling. A Live model name such as `gemini-3.8-live` is rejected with a clear error. |
| `GEMINI_BACKUP_MODELS` | no (`gemini-3.6-flash,gemma-4-26b-a4b-it,gemini-3.8-flash,gemma-4-31b-it,gemini-4-hydrogen`) | Agent backups, tried in order when the main model is overloaded, rate limited, slow or missing. Empty means no backups. |
| `SMARTCART_MATCH_MODEL` | no (`gemini-3.1-flash-lite,gemini-3.5-flash-lite`) | Product-checking models. Checking calls are spread evenly across them. |
| `SMARTCART_MATCH_BACKUP_MODELS` | no (`gemini-3.6-flash,gemini-3.8-flash,gemma-4-31b-it,gemini-4-hydrogen`) | Checking backups, used only when every checking model is busy. Empty means no backups. |
| `SMARTCART_MATCH_CONCURRENCY` | no (`12`) | Most product-checking calls to Gemini running at the same time across the whole server process (1 to 64). Each cart is also limited to 12. |
| `GEMINI_LIVE_MODEL` | no (`gemini-3.8-live`) | Gemini Live model for the website's voice feature (it listens and speaks) and for the legacy CLI in `engine/`. |

## MongoDB setup

1. In Atlas, create a database user with `readWrite` on the `smartcart` database. A narrowly scoped user is safer than an admin user, especially when the cluster hosts other projects.
2. Add your machine's IP address (or your deployment's egress addresses) under **Network Access**.
3. Put the connection string in `MONGODB_URI` and run `npm run db:indexes`.
4. Import the catalog once. The original JSON is backed up outside the project at `C:\Users\UPDATE\SmartCart-backups\catalog\smartcart_products_DB(2).json` with a SHA-256 manifest.

```powershell
$catalog = 'C:\Users\UPDATE\SmartCart-backups\catalog\smartcart_products_DB(2).json'
npm run db:migrate -- --source $catalog --dry-run     # validate only
npm run db:migrate -- --source $catalog               # upsert; safe to rerun
npm run db:verify -- --source $catalog                # field-by-field and search-equivalence checks
npm run db:verify                                     # database-only consistency checks
npm run catalog:audit -- --as-of 2026-11-19           # data-quality audit
```

The migration validates every record, enforces the offer identity `retailer:chainId:subChainId:storeId:productCode`, and rejects conflicting duplicates instead of guessing. It skips unchanged offers by content hash, so a rerun writes nothing. Each run saves a report in `reports/`. `--prune` removes offers of the imported stores that the source no longer lists. Scripts refuse database names that do not start with `smartcart`.

At runtime the application reads products only from MongoDB. If the database is unreachable, requests fail with `DATABASE_UNAVAILABLE`; there is no fallback to a local file.

### Collections and indexes

| Collection | Contents | Indexes |
| --- | --- | --- |
| `products` | Original catalog fields, plus `storeKey`, `normalizedName`, `searchTokens`, `pricing.listedPriceCents`, `catalog.contentHash`, `dataQuality`, `importedAt` and `updatedAt`. `_id` is the offer identity. | `offer_identity_unique` (unique), `search_tokens_store`, `store_product_code`, `product_code` |
| `stores` | One document per exact store: identifiers, a display name derived from the retailer and store ID, counts and snapshot dates. No invented addresses. | `retailer_store` |
| `shopping_sessions` | Anonymous session, SHA-256 hash of its secret token, the last 200 chat messages, pending clarification and run lock. Expires 30 days after the last activity. | `session_expiry_ttl`, `session_updated` |
| `carts` | The authoritative cart: requested items with requirements, preferences and source wording, mode, budget, recipe plans, selected store, the verified calculation, `revision` and `itemsVersion`. | `cart_session_unique` (unique), `cart_expiry_ttl`, `cart_updated` |
| `agent_runs` | Per run: status, model, duration, model turns, tool summaries, matcher calls, token usage and errors. No prompts, reasoning or secrets. Kept 30 days. | `run_session_started`, `run_expiry_ttl` |
| `match_cache` | Validated matcher decisions keyed by item constraints, the offer, a fingerprint of the product's name, manufacturer and package, and the model. Kept 14 days. | `match_cache_ttl`, `match_cache_product` |

**Several models share the work.** Product checks rotate across the checking models; the agent uses its main model. A model that answers 429/503, times out (30 s per agent turn, 40 s per batch of checks) or is missing (404) rests for a minute (30 minutes when missing) and the call moves to the next model at once. One record of resting models is shared by the whole server. When a run switches models, earlier thought signatures are replaced with Gemini's documented skip value so the next model accepts the history. The defaults come from a live test of every model on the project's key: `gemini-3.5-flash-lite` checks products well but builds invalid cart changes, so it only checks; `gemma-4-26b-a4b-it` builds carts but timed out on product checks; `gemini-2.5-flash` and `gemini-2.5-flash-lite` returned 404.

`match_cache` is the only collection beyond the suggested set. It exists because product matching dominates cost and latency: "חלב" alone has 392 candidates. Cached decisions are revalidated deterministically before reuse. A change to the requirements, the model, or the product's name, manufacturer or package produces a new key. Price and date changes keep the key, so a catalog refresh does not repeat the checks; prices always come from the current record.

## How it works

```
Browser (Next.js UI) ──POST /api/agent (SSE)──▶ Agent loop (Gemini function calling)
        ▲                                         │  allowlisted tools, Zod-validated arguments
        │ cart.updated / tool events               ▼
        └──────────── Cart (MongoDB) ◀── Shopping pipeline (TypeScript adapters + engine/)
                                              search → match → quantity & price → optimize → verify
                                                 │
                                                 └── products, stores, match_cache (MongoDB Atlas)
```

### The agent

`src/lib/agent/` runs a bounded plan → act → observe loop with Gemini function calling. Each customer message starts one run. Gemini chooses tools, the backend executes them, and Gemini sees the actual results before deciding what to do next.

| Tool | What the backend does |
| --- | --- |
| `getCurrentCart` | Reads the authoritative cart from MongoDB. |
| `updateCart` | Adds direct items or recipe ingredients, removes items, changes quantities, requirements, preferences, search terms, mode, budget or store, or clears the cart. Every change is validated and saved with a revision check. |
| `searchProducts` | Full-recall MongoDB retrieval for cart items, or bounded catalog exploration ("do you have oat milk?"). |
| `matchProducts` | The original matcher: Gemini judges identity and each mandatory requirement; deterministic code verifies the evidence against catalog data. Results are MATCH, NO_MATCH or UNCERTAIN. |
| `calculatePurchaseOptions` | Whole-package counts, unit conversion, totals and extra quantity per store. Weighted offers are estimates only. |
| `optimizeBasket` | Complete single-store baskets in cheapest, balanced and preferences-first modes, independently verified and saved. Runs missing earlier stages automatically. |
| `compareStores` | Verified totals per store and the reasons a store is incomplete. |
| `explainRecommendation` | Verified facts for "why": requirement evidence, preferences, package math and the mode rule. |
| `requestClarification` | Asks one essential question and ends the run. |

Safeguards:

- **Allowlist and validation.** Unknown tools and invalid arguments are rejected and reported back to the model, which can correct itself. Gemini never sees raw database access, shell commands or code execution.
- **Limits.** 10 model turns, 24 tool calls and 8 calls per turn per run; each model gets 30 seconds per turn before a backup model takes over (100 seconds per turn in all), with up to three retries for transient errors (2, 5 and 10 seconds apart when Gemini reports overload or rate limits); per-tool timeouts; a 270-second run deadline. When a limit is reached, the model must answer in text. Each session allows one active run and at most 20 runs per 10 minutes. Product checks run at most 12 at a time per cart, and a single large item can use all 12; the server allows at most `SMARTCART_MATCH_CONCURRENCY` (12) at a time; a cancelled request leaves the queue immediately. Vague requests such as "something tasty with chocolate" are never searched as a whole category: the agent adds the specific items and asks which product the customer means.
- **Grounded extraction.** New items must be copied verbatim from the customer's message and pass the engine's request-coverage validator, which rejects a dropped "3%" or quantity. Wording left next to the extracted span that holds a number, qualifier, "preferably" or "only" is rejected. New requirements and preferences must appear in the customer's words, and a mandatory requirement can be relaxed only when the customer names it.
- **Independent verification.** Before a basket is shown, `src/lib/shopping/validation.ts` reloads every product from MongoDB and recomputes the following: store identity, prices in integer cents, package interpretation (for example, a "1 unit" listing of a 12-egg carton), requirement proof, quantity coverage, preferences, totals, and the mode and budget rules. A failed check marks the cart `VERIFICATION_FAILED`, and no total is shown.
- **Final validation.** If the cart changed after the agent's last calculation, the backend recalculates and verifies it before the final answer, and the model answers from the verified result.
- **Recipes.** Gemini plans ingredients and quantities for meal requests. There is no hard-coded recipe library. Plans are validated (servings, quantities, Hebrew search terms, grounded constraints), and optional extras are listed but not added. Prices always come from the catalog.

### Voice

Voice adds a way in and out; the shopping work does not change.

1. The customer taps the microphone. The browser asks `POST /api/voice/token` for a short-lived Gemini Live token. The token works once, must be used within 60 seconds, expires after 30 minutes, and locks every Live setting (instructions, tool, transcription), so the browser cannot repurpose it. The real API key never leaves the server.
2. The browser connects to Gemini Live directly, streams microphone audio (16 kHz PCM) and plays the spoken reply (24 kHz PCM). Speaking while SmartCart talks interrupts it.
3. Live transcribes the customer's words and calls its only tool, `shopping_agent`, with the request. The browser passes it to `POST /api/agent` with `via: "voice"`, the same agent and checks as typed messages. Spoken numbers are converted first ("three percent" becomes "3%"), and the chat shows the exact text the agent used.
4. The verified answer goes back to Live, which reads it out loud without changing numbers. The chat shows the request, the answer, live captions and the same progress steps as for typing.

Small talk that never reaches the agent is answered by Live directly and shown in the chat for that page only. Voice needs microphone permission and a secure page (HTTPS or `localhost`).

### Streaming

`POST /api/agent` returns Server-Sent Events that report real backend activity only: `agent.started`, `tool.started`, `tool.progress` (for example "Checked 120 of 392 products for milk"), `tool.completed`, `cart.updated`, `clarification.required`, `agent.completed` and `agent.failed`. Closing the page cancels the run.

### API

| Route | Purpose |
| --- | --- |
| `POST /api/sessions` | Start an anonymous session. Sets an HttpOnly, SameSite=Lax cookie holding the session ID and a 256-bit token; only its hash is stored. |
| `GET /api/sessions` | The current conversation and cart. |
| `GET /api/cart` | The cart view. |
| `PATCH /api/cart` | One UI edit, `{ expectedRevision, operation }`. Returns 409 when the cart changed in the meantime. Edits are recalculated and verified on the server. |
| `POST /api/agent` | `{ message }` and an SSE stream. |
| `POST /api/voice/token` | A single-use, locked Gemini Live token for the browser's voice session. Requires a session; at most 20 per session per 10 minutes. |
| `GET /api/health` | Database and catalog status. |

Mutating routes reject cross-site `Origin` headers. Errors use `{ error: { code, message } }` with secrets redacted.

## Tests

| Command | Scope | Network |
| --- | --- | --- |
| `npm test` | Legacy engine suite (247) plus unit, agent, voice, limit and model-pool tests (86) | none |
| `npm run test:db` | Database and integration tests (25) on a disposable `smartcart_test_*` database that is dropped afterwards | Atlas |
| `npm run test:e2e` | HTTP tests against `next start` (4); run `npm run build` first | Atlas |
| `npm run typecheck` | TypeScript across the app, scripts and tests | none |
| `npm run benchmark` | MongoDB search and pipeline timing with a local matcher stand-in | Atlas |

Ordinary tests use deterministic fixtures: `tests/fixtures/catalog-sample.json` holds every catalog offer that matches the tested search terms (1,037 offers), so searches return the same candidates as the full catalog. Model responses come from scripted fakes. Database tests never touch the application database.

Real Gemini calls run only on request and spend API credits:

```powershell
npx tsx scripts/live-agent-smoke.ts "I want 2 liters of 3% milk, preferably Tnuva, and 12 eggs" --allow-live --cleanup
npx tsx scripts/live-voice-smoke.ts "I want two liters of three percent milk and twelve eggs" --allow-live --cleanup
npm run test:live -- --allow-live    # legacy CLI scenarios over Gemini Live
```

## Project structure

```
src/app/              Next.js pages and API routes (sessions, cart, agent, health)
src/components/       Chat, cart, store comparison and shadcn/ui primitives
src/lib/agent/        Agent loop, tools, prompts, schemas, Gemini client, events
src/lib/shopping/     Pipeline, MongoDB search, cached matching, pricing, optimizer, verification, cart operations
src/lib/db/           MongoDB connection, indexes and repositories
src/lib/catalog/      Catalog normalization, import and verification
engine/               The original deterministic engines (.mjs) with TypeScript declarations, plus the legacy CLI
scripts/              Indexes, migration, verification, backup, audit, benchmark, live smoke test
tests/                engine/ (legacy), unit/, agent/, database/, integration/, e2e/, fixtures/, helpers/
```

The engines in `engine/` hold the matching, package-interpretation and basket-optimization logic, and keep their own 247 regression tests ([QA report](SMARTCART-QA.md)). The web application calls them through typed adapters instead of reimplementing them.

### Legacy CLI

The original file-based pipeline still works for development. It uses the Gemini Live API (`GEMINI_LIVE_MODEL`) and needs an explicit catalog file, because the production catalog now lives in MongoDB:

```powershell
$catalog = 'C:\Users\UPDATE\SmartCart-backups\catalog\smartcart_products_DB(2).json'
node engine/smartcart-llm.mjs 'I want 2 liters of 3% milk, preferably Tnuva, and 12 eggs'
node engine/smartcart-matcher.mjs search shopping-request.json $catalog 0
node engine/smartcart-matcher.mjs match shopping-request.json search-results.json 0
node engine/smartcart-quantity-price.mjs match-results.json shopping-options-0.json
node engine/smartcart-basket-optimizer.mjs --request shopping-request.json shopping-options-0.json
```

Repeat the search, match and quantity steps for each item index. The CLI writes its intermediate JSON files to the current folder.

## Limitations

- Prices are snapshots, not live stock, promotions, delivery fees or checkout totals. Checkout and payment are future integrations.
- Two stores are loaded. More stores and fresher snapshots need a recurring import, which the idempotent migration supports.
- Matching quality depends on catalog wording. Many names are abbreviated, and about a third of offers have no manufacturer, so brand requirements often remain unverified (UNCERTAIN) and those offers are excluded.
- An item whose search returns more than 800 candidates is truncated. The agent is told to use more specific Hebrew terms.
- The first match of a new item costs Gemini calls in proportion to the candidates (about 25 per call). Repeats are served from `match_cache`.
- The server-wide limit on checking calls counts calls within one server process. Several server instances each have their own limit.
- Weighted products stay out of automatic baskets until store-specific weighing rules are verified.
- Recipe quantities are model estimates and are labelled as such.
- The deterministic validator is strict: unusual phrasing can make the agent retry or ask the customer to rephrase.
- The UI is in English, follows the device's light or dark setting (with a switch in the header), and uses logical (start/end) layout properties for future Hebrew and Arabic RTL locales. Hebrew and Arabic chat already works.
- Voice was tested end to end with real Gemini models (Live, the agent and MongoDB), but without a real microphone and speakers; test it in each browser you support. Gemini's ephemeral tokens are marked experimental in the SDK, and the voice token limit is kept in server memory.
- A spoken answer starts after the agent finishes, typically about 10 seconds for a new request.
- When the microphone starts, the voice model gets up to 12 recent saved chat messages so it understands follow-ups such as "yes, do it". Voice small talk that never reached the agent is shown in the chat but not saved on the server.

## Before production

- Use a least-privilege Atlas user, restrict network access, and enable backups and alerts. Keep SmartCart in its own project or cluster.
- Serve over HTTPS; the session cookie becomes `Secure` automatically.
- Add accounts or another identity layer if carts must follow users across devices, and add per-IP rate limiting at the edge.
- Monitor Gemini cost and latency through `agent_runs`, and set provider quotas. Set `SMARTCART_MATCH_CONCURRENCY` to fit your Gemini rate limits.
- Set up recurring catalog imports with verification, and alert when price dates become stale.
- Run the live agent and voice smoke scripts with representative requests in each language, and test voice on real devices, before every release.
