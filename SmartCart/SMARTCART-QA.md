# SmartCart QA report

> This report covers the deterministic engines, which now live in `engine/` with their tests in `tests/engine/`. The catalog moved from the JSON file to MongoDB Atlas on 2026-11-19: the catalog-backed tests read `tests/fixtures/catalog-sample.json` (every offer matching the tested terms, so results are unchanged), and the audit and benchmark read MongoDB. The web agent's tests and setup are described in [README.md](README.md).

## Verification

The suite ran on Windows PowerShell with Node.js 22 and the local catalog snapshot. The starting suite passed 69 tests. The expanded offline suite passed **247 tests**, with **0 failures** and **0 skips**. All model responses in the suite and benchmark were controlled fixtures. The opt-in command was verified to exit before loading Gemini without the flag. Gemini calls during this work totaled **0**.

| Coverage | Tests and data |
| --- | --- |
| T01–T24 and customer acceptance | [65 direct-request tests](tests/engine/qa-requests.test.mjs) and [58 reusable requests](tests/engine/fixtures/acceptance-requests.mjs). Cases specify expected quantities, qualifiers, preferences, or validation errors in English, Hebrew, Arabic, and mixed-language requests. |
| T25–T94 | [72 search, match, quantity, and optimizer tests](tests/engine/qa-core.test.mjs) with [reusable fixture products and model replies](tests/engine/fixtures/qa-catalog.mjs). T72 checks that catalog-only claims about weighted rules leave estimates unverified. |
| T95–T104 | [Catalog-backed pipeline regressions](tests/engine/smartcart-pipeline.test.mjs), [ranges and alternatives](tests/engine/range-choice-pipeline.test.mjs), and [system tests](tests/engine/qa-system.test.mjs). |
| T105–T112 | [Mocked benchmark](engine/smartcart-benchmark.mjs), [system tests](tests/engine/qa-system.test.mjs), and [matcher recovery tests](tests/engine/matcher.test.mjs). Timing details appear below. |
| R01–R20 | [29 recipe, pantry, and mixed-pipeline tests](tests/engine/recipe-planner.test.mjs), plus budget, gluten-free, and recipe CLI coverage in [system tests](tests/engine/qa-system.test.mjs). |

The four-item fixture checks the 3% milk requirement, optional Tnuva preference, 12-egg carton, and same-store cost of every item. The package regression confirms one 12-egg Shufersal carton at ₪15.81. Price and preference optimization agreed with exhaustive enumeration in 80 generated basket scenarios. Other checks cover item coverage, integer package counts, price sums, store IDs, contradictory or unknown claims, preference provenance, reordered candidates, request-bound artifacts, and failure recovery. A 20-item fixture retained all 20 lines through the basket stage.

## Defects reproduced and corrected

- The parser could drop “1 liter each” even when it recognized a count of three bottles. It now retains and verifies the exact per-container size. The cheaper half-liter fixture remains ineligible.
- Direct request accounting could reject “any eggs,” Arabic quantities or preference wording, and a repeated purchase described as “another 2 liters of the same milk.” The fixtures exercise these forms, explicit percentage conflicts, and frozen or vegan wording that must survive extraction.
- A brand in the offer title could conflict with the named manufacturer. The matcher now treats conflicting recognized brands as uncertain and checks positive label evidence for supported dietary and product-form requirements.
- A transient timeout or rate limit could end a batch immediately. Recognized temporary failures now use bounded backoff, and completed candidate decisions remain available for resume.
- Repeated identical records could survive broad search in groups that also contained conflicting variants. Search now deduplicates identical records while exposing conflicting offers for validation.
- An edited match artifact could claim 3% milk while carrying a contradictory 1% title. The quantity stage now independently blocks provable hard-claim and per-package-size contradictions before costing an offer.
- Several individually representable line prices could sum beyond safe integer-cent arithmetic. The optimizer now excludes those combinations and records a reason for stores with unpriceable complete baskets.

## Read-only catalog audit

The audit used **2026-11-19** and flagged price records older than 30 days. The exact catalog SHA-256 matched before and after the work.

| Measure | Result |
| --- | ---: |
| Total records | 31,330 |
| Rami Levy store 039 | 15,445 |
| Shufersal store 413 | 15,885 |
| Records with confirmed data errors | 51 |
| Records with only suspicious flags | 19,284 |
| Records without a flag from these checks | 11,995 |
| Missing manufacturer names | 10,023 |
| Missing, zero, or invalid listed prices | 0 |
| Missing package units | 46 |
| Nonpositive or invalid package quantities | 5 |
| Unsupported package units | 97 |
| Possible title and package conflicts | 2,615 |
| Suspect published-unit-price comparisons | 11,324 of 29,900 checked |
| Weighted records without verified increments | 1,472 |
| Price dates older than 30 days | 9,710 |
| Duplicate record IDs or duplicate barcode within one store | 0 |
| Product codes present at more than one exact store | 4,726 |

The overall classifications are disjoint. Individual issue counts can overlap. The unit-price check uses a comparable normalized basis and flags differences above the larger of ₪0.03 and 3%. Published prices can use a different reference or reflect rounding. The flag identifies records for review, and basket prices use the listed price.

## Measured performance

One offline benchmark run found 392 candidates for `חלב` in the 31,330-record catalog. It took **708.45 ms** including file read and parse.

| Stage | Measured time |
| --- | ---: |
| Catalog read and parse | 389.95 ms |
| Build index | 191.03 ms |
| Search | 23.51 ms |
| Matcher with model double | 15.34 ms |
| Quantity and price | 82.39 ms |
| Basket optimization | 4.60 ms |

The matcher evaluated all 392 candidates in 33 mocked calls, with at most 12 candidates per call and 198,760 UTF-8 prompt bytes in total. Heap usage at the end of this run was 132.4 MiB. Timings vary by process and machine. The benchmark captures local execution time, prompt bytes, and mock call counts. Token usage and API billing were unavailable. Reusing a valid checkpoint avoided repeated calls in the recovery tests. Repeated catalog loads across CLI invocations and shared candidate metadata are measurable opportunities to reduce work while preserving search recall and per-store offers.

## Remaining limitations

- Local recipe templates cover pizza, pancakes, cake, chicken and rice, and pasta. A complete, fixed daily request can repeat a named template. Open-ended multi-day menus and unsupported dietary combinations can ask for clarification. Recipe quantities are versioned estimates, and template-default serving counts are labeled.
- Pantry deductions need compatible quantities and enough evidence for any applicable dietary constraints. Suggested optional ingredients stay in the recipe record until the user requests them. Catalog labels have limited coverage for ingredients and cross-contact.
- Live stock, store-specific weight increments, price changes, promotions, and checkout totals require separate verification. Weighted estimates stay out of automatic purchases. Trusted weighted increments would require store-specific records and separate tests.
- Stage files are checked for consistency and obvious contradictions. The files assume a trusted local workspace. Live Gemini behavior can vary with wording and model availability. The optional live suite has separate expectations and remains permission-gated.

## PowerShell commands

```powershell
npm.cmd run test:engine
node engine/smartcart-benchmark.mjs                 # in-memory benchmark over the test fixture
npm.cmd run catalog:audit -- --as-of 2026-11-19      # audit of the MongoDB catalog
```

The live command requires permission to use Gemini credits. It logs ten bounded scenarios as JSON lines.

```powershell
npm.cmd run test:live -- --allow-live
```

In a restricted Windows sandbox, set the following for the current session if Node cannot resolve the workspace path.

```powershell
$env:NODE_OPTIONS = '--preserve-symlinks --preserve-symlinks-main'
```

## Files added or updated

| Area | Files |
| --- | --- |
| Planning and validation | `engine/smartcart-llm.mjs`, `engine/smartcart-request-coverage.mjs`, `engine/smartcart-plan-validation.mjs`, `engine/smartcart-recipe-planner.mjs`, `engine/smartcart-recipes.mjs` |
| Existing shopping stages | `engine/smartcart-search.mjs`, `engine/smartcart-matcher.mjs`, `engine/smartcart-requirement-evidence.mjs`, `engine/smartcart-quantity-price.mjs`, `engine/smartcart-pipeline-context.mjs`, `engine/smartcart-basket-optimizer.mjs` |
| QA scripts and documentation | `engine/smartcart-catalog-audit.mjs`, `engine/smartcart-benchmark.mjs`, `engine/smartcart-live-qa.mjs`, `package.json`, `README.md`, `SMARTCART-QA.md` |
| Tests and fixtures | `tests/engine/fixtures/qa-catalog.mjs`, `tests/engine/fixtures/acceptance-requests.mjs`, `tests/engine/qa-requests.test.mjs`, `tests/engine/qa-core.test.mjs`, `tests/engine/qa-system.test.mjs`, `tests/engine/recipe-planner.test.mjs`, `tests/engine/smartcart-llm.test.mjs` |
