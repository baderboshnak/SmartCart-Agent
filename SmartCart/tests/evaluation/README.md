# SmartCart evaluation

Run the commands from the SmartCart directory. The comprehensive runner records each case in reports/evaluation/evaluation.json and its readable companion evaluation.html. Section commands write separate files in the same directory. Failed cases produce a nonzero exit after the report is written.

| Command | Scope |
| --- | --- |
| npm run test:all:offline | Existing suites and all sections below under the network guard |
| npm run test:scenarios | Authored multilingual requests against the real agent, tools and cart with scripted Gemini |
| npm run test:retrieval | Independently labelled catalog retrieval and cheapest-valid-offer checks |
| npm run test:matching | Matcher behavior and shared intent reading with labelled simulated responses |
| npm run test:validation | Malformed decisions, contradictory evidence and the boundary of backend validation |
| npm run test:cache | Shared cache keys, expiry, lifecycle, writes and concurrent cold requests |
| npm run test:optimizer | Deterministic baskets against an independent price oracle |
| npm run test:failures | Timeouts, retries, network/provider failures, cancellation and locks |
| npm run test:performance | Backend-only controls and simulated model latency profiles |
| npm run test:voice | Gemini Live browser integration with simulated SDK events |
| npm run test:response | Verified basket compared with the final assistant text |
| npm run test:replay | Intact recorded tool inputs scored against current schemas |
| npm run test:report | Regenerate HTML from a prior comprehensive JSON report |

PowerShell users can use npm.cmd run if script execution is restricted. The same sections can be run directly.

    node --preserve-symlinks --preserve-symlinks-main --import ./tests/evaluation/offline-guard.mjs --import tsx tests/evaluation/run.ts all

In the Windows project sandbox, set `$env:NODE_OPTIONS='--preserve-symlinks --preserve-symlinks-main'` before running npm.cmd if npm reports a user-profile lstat permission error.

## Provenance

- **MOCK** runs production backend code with scripted model replies. Its pass rate describes how the backend handled those inputs.
- **REPLAY** scores intact recorded response projections. Clipped, redacted or missing information is identified separately. Replay metrics describe the recorded sample.
- **DETERMINISTIC** covers actual code and labelled catalog data. Retrieval reports state whether queries ran in MongoDB or against a local snapshot and reference search engine.
- **LIVE** is a separate opt-in command for measuring current model behavior on evaluation inputs.

The authored customer and catalog fixtures are in scenario-data.ts. Held-out cases are separate from development examples. The reply scripts exercise backend invariants. Evaluating actual Gemini responses to held-out inputs requires live evaluation or complete real recordings. The matching section also uses the existing independently labelled semantic candidates, with debatable entries excluded from scoring.

Performance profiles run the real agent, cart, matcher validator and optimizer with an in-memory test adapter. Backend-only control samples omit simulated waits. These results measure one machine and fixture. Production database and model latency require separate measurements.

## Isolated database

Set SMARTCART_EVAL_MONGO_URI to an isolated MongoDB server to run the database regression and retrieval suites. The default offline runner clears the app's MongoDB URI for regression children. Database suites create and clean up disposable smartcart_test_* databases. For a separately authorized remote isolated server, set its exact host and port in SMARTCART_EVAL_MONGO_HOSTS before the guard starts. Localhost is allowed for local test infrastructure.

Set SMARTCART_EVAL_CATALOG to a local read-only JSON catalog export to evaluate a full snapshot. The runner checks SmartCart-backups/catalog/smartcart_products_DB(2).json under the home directory by default and falls back to the repository sample if it is missing. The full evaluation used the 31,330-offer backup. Reproduce that run from PowerShell with the appropriate export path.

    $env:SMARTCART_EVAL_CATALOG='C:/Users/UPDATE/SmartCart-backups/catalog/smartcart_products_DB(2).json'
    npm.cmd run test:all:offline

Retrieval results apply to the labelled requests and the tested snapshot. The report identifies manually reviewed barcodes, ambiguous products and offers that still lack labels.

## API budget

The offline guard loads before app code and passes to test child processes. It clears provider keys and blocks external API traffic before the connection. The comprehensive command runs the offline evaluation.

After explicit authorization, npm run test:live:budgeted -- --allow-live --request "I want milk" runs the separate live planner evaluator. Use --semantic-case bread in place of --request to evaluate one labelled matching case. Defaults allow at most 10 total API attempts, 15,000 input tokens, 4,000 output tokens and USD 0.05 in estimated cost. Token-count preflights count toward the attempt cap. The flags --max-attempts, --max-input-tokens, --max-output-tokens and --max-cost-usd can supply tighter limits. Estimated cost depends on provider pricing and usage responses. A failed attempt counts against the evaluation budget.

Use `--coverage` in place of `--request` for the varied live smoke suite. It uses one shared cap, one model generation per case, and writes `reports/evaluation/live-coverage.html` and `live-coverage.json`. Agent cases use the real prompt and validate the first reply with production tools on isolated carts. The matcher case checks five labelled candidates in one generation.

    npm run test:live:budgeted -- --allow-live --coverage --max-attempts 10 --max-input-tokens 26000 --max-output-tokens 3500 --max-output-per-attempt 1100 --max-cost-usd 0.04

## Gemini mistakes and phrasing (mock)

The customer scenarios include five more groups (SC-317 onward), each labelled with the correct behavior so a current gap shows as a failure:

- model-mistakes: scripted Gemini errors. A malformed function call followed by the right action, two malformed calls, text that claims an addition without any action, a dropped item, a wrong amount or invented brand that is then corrected, one mention listed twice, an English reply to a Hebrew customer, and a price that is not in the verified basket.
- phrasing: amounts without digits, number words and dual forms in Hebrew, Arabic and English ("קילו עגבניות", "חצי קילו גבינה", "שתי חבילות פסטה", "كيلوين رز", "علبتين تونة", "a dozen eggs", "half a kilo of cheese").
- conversation, mixed and large: corrections, an answer to a clarification, a language switch, remove then add back, removing a product that is not in the cart, a later budget, clear then add, an Arabic follow-up, "make it cheaper" keeping the brand, mixed-language messages, and 10- and 15-item carts.

## Live agent on labelled scenarios

`npm run test:live:scenarios` runs a sample of the labelled scenarios with the real Gemini agent and product matcher, through the production backend, an in-memory store and the synthetic two-store catalog. Live scoring checks outcomes rather than exact tool calls: the cart lines, the fixture products bought, the basket status, budget, servings and kept requirements, the reply language, empty-cart and "added" claims, and that every quoted price is in the verified cart.

    npm run test:live:scenarios -- --estimate                   # sample and estimated cost, no calls
    npm run test:live:scenarios -- --dry-run                    # offline check with the scripted model, no calls
    npm run test:live:scenarios -- --allow-live --small         # 12 scenarios, about $0.13, capped at $0.15
    npm run test:live:scenarios -- --allow-live                 # 27 scenarios, about $0.27, capped at $0.35

Each call is priced from the usage Gemini reports ($0.30 per million input and $2.50 per million output tokens by default; pass `--input-usd-per-million` and `--output-usd-per-million` for another model). A call is refused before it starts if it could pass `--max-cost-usd`. Results are written to `live-agent-scenarios.html` and `.json`.

## Approved $0.60 campaign

The separately approved campaign sends 315 synthetic first replies in a discounted Gemini Batch job. It checks the empty input locally, follows eight isolated text flows through the production backend, and runs three short Gemini Live audio probes. `--prepare` checks the payload locally. `--approved-0.60` enables provider calls when explicitly authorized. The journal in `reports/evaluation/approved-live-ledger.json` tracks submissions and persistent reservations across phases. Keep this journal when resuming the same campaign. Individual response failures are reported from the stored result. The campaign does not re-submit paid work automatically.

`--collect-only` fetches the existing batch and scores its recorded case IDs. On Windows with local Hebrew, Arabic, and English voices installed, run `tests/evaluation/make-approved-voice-fixtures.ps1` to generate synthetic WAV inputs. `--prepare-voice` validates their format and duration locally.

    npm run test:live:approved -- --prepare
    npm run test:live:approved -- --approved-0.60

The human-readable and JSON results are `reports/evaluation/approved-live-campaign.html` and `approved-live-campaign.json`.

The generated reports stay in the Git-ignored reports/evaluation directory. Replay reports schema outcomes without reproducing customer transcripts. To replay a specific local trace, pass its path after npm run test:replay --.
