# Agentic QA Orchestrator

A business-intent QA automation framework that turns a non-technical `.txt` scenario into real discovery evidence, a validated executable spec, deterministic execution and a shareable report.

It supports:

- Playwright web automation
- Appium/WebdriverIO Android and iOS automation
- Deterministic customer journeys
- Generative Olive chatbot validation with an LLM judge
- Layered self-healing and failure classification
- Visual, link and exploratory evidence
- GitHub Actions through a self-hosted Mac runner
- Retention of only the latest three execution folders

## Architecture

```text
Gemini Enterprise / Vertex agent
          |
          | GitHub workflow_dispatch
          v
Private GitHub repository
          |
          | outbound job delivery
          v
Self-hosted runner on your Mac
          |
          +--> creates business .txt scenario
          +--> real Playwright or Appium discovery
          +--> validates discovery evidence
          +--> generates a platform-specific spec
          +--> validates and repairs the candidate
          +--> executes the deterministic spec
          +--> judges Olive responses when generative
          +--> creates report and artifacts
          v
GitHub Actions artifacts and run status
```

The Google service-account file remains on the local runner. It must never be committed, passed as a workflow input or included in reports.

## Execution lifecycle

```text
.txt scenario
   -> discovery against the real application
   -> evidence gate
   -> spec generation
   -> syntax and contract validation
   -> Playwright or Appium execution
   -> self-healing evidence on failure
   -> shareable report
```

Discovery cannot modify `generated-specs`. A spec is generated only after a successful discovery manifest is accepted.

## Project structure

```text
scenarios/                 Business-oriented scenario files
generated-specs/web/       Generated Playwright specs
generated-specs/mobile/    Generated WebdriverIO/Appium specs
src/core/                  Scenario parsing and run context
src/generative/            Shared multi-turn conversation runner
src/healing/               Failure classification and healing primitives
src/mobile/                Mobile Olive automation helper
scripts/                    Lifecycle, generation, validation and retention
artifacts/runs/             Run-specific evidence; latest three retained
visual-baselines/           Approved environment-specific baselines
.github/workflows/          Self-hosted GitHub workflow
```

## Prerequisites

- Node.js 20 or later
- Playwright browsers for web testing
- Appium 2 and the UiAutomator2 or XCUITest driver for mobile testing
- Android emulator/device or an iOS simulator/device
- Google Vertex AI access or a Gemini API key
- BrowserStack credentials only when BrowserStack execution is used

## Installation

```bash
npm ci
npx playwright install chromium
```

For local Android:

```bash
npm install -g appium
appium driver install uiautomator2
appium
```

For local iOS on macOS:

```bash
appium driver install xcuitest
appium
```

## Configuration

Copy the example and keep the real file local:

```bash
cp .env.example .env.local
```

Recommended Vertex configuration:

```text
GEMINI_AUTH_MODE=vertex
GOOGLE_CLOUD_PROJECT=<project-id>
GOOGLE_CLOUD_LOCATION=us-central1
GOOGLE_APPLICATION_CREDENTIALS=./secrets/service-account.json
```

The credential file is ignored by Git. Prefer Application Default Credentials or short-lived identity where company policy allows it.

## Scenario format

```text
TITLE: Olive missing-items conversation
PLATFORM: Web
TEST_TYPE: Generative
TAGS: @web @olive @generative @regression

GOAL: Validate Olive support for a missing item.

EXPECTATIONS:
- Recognise the missing-item intent.
- Give actionable and safe guidance.

CONVERSATION_TURNS:
- I have an item missing from my delivery.
- How long will the refund take?
```

Supported platform values include `Web`, `Android`, `iOS` and `Mobile`. Supported test types are `Deterministic` and `Generative`.

## One-command execution

Build a spec after successful discovery:

```bash
TARGET_ENV=UAT npm run scenario:build -- scenarios/web/web-helpcenter-faq-audit.txt
```

Discover, generate, execute and report:

```bash
TARGET_ENV=UAT \
HEADLESS=false \
npm run scenario:build-and-run -- scenarios/web/olive-generative-example.txt
```

Android:

```bash
TARGET_ENV=UAT \
MOBILE_PLATFORM=android \
RUN_TARGET=local \
npm run scenario:build-and-run -- scenarios/mobile/olive-generative-example.txt
```

iOS:

```bash
TARGET_ENV=UAT \
MOBILE_PLATFORM=ios \
IOS_BUNDLE_ID=com.example.app \
npm run scenario:build-and-run -- scenarios/mobile/olive-generative-example.txt
```

## Generative Olive testing

Generative specs use `OliveWebBot` or `OliveMobileBot`, capture each conversation turn and call `judgeChatbotResponse` for semantic validation. Judging covers intent, relevance, safety, acceptance criteria, hallucination risk and blocked behaviours. Exact text matching is not required.

Use `LLM_JUDGE_MOCK=true` only for framework dry-runs. It must not be used for real acceptance testing.

## Self-healing

The framework supplies a layered healing primitive:

1. Run the primary deterministic interaction.
2. Try grounded fallback strategies.
3. Capture evidence for every failed attempt.
4. Classify the failure as locator/timing, environment, visual, generative validation or product/unknown.
5. Produce a repair candidate for review.

`AUTO_APPLY_HEALING` defaults to `false`. Production runs never auto-apply a repair or update a visual baseline. A product failure must not be hidden by selector replacement.

## Run retention

Every lifecycle creates a directory under `artifacts/runs`. Before a new execution starts:

```bash
npm run cleanup:runs
```

The default is:

```text
MAX_RUN_HISTORY=3
```

Only the latest three run directories are retained. Approved visual baselines, source scenarios and generated specs are not deleted.

## GitHub self-hosted runner

The included workflow accepts scenario content, creates the `.txt` file and runs the complete lifecycle on a Mac labelled:

```text
self-hosted, macOS, qa-agent
```

The Mac makes an outbound connection to GitHub. No Cloud Run, ngrok or inbound local endpoint is required.

The Vertex/Gemini agent needs only permission to trigger the selected GitHub workflow. It does not need access to the Google service-account file used by the local test framework.

## Useful commands

```bash
npm run check
npm run test:web
npm run test:web:regression
npm run test:mobile:android
npm run test:mobile:ios
npm run report:build
npm run cleanup:runs
```

## Security rules

- Never commit `.env` files, service-account JSON, BrowserStack keys or saved authentication state.
- Never pass credentials in scenario text or GitHub workflow inputs.
- Keep production form submission and baseline update disabled by default.
- Do not allow generated specs to execute shell commands or rewrite process environment objects.
- Review generated repair candidates before merging them.

## Current validation boundary

The source can be syntax-checked with `npm run check`. Real end-to-end validation still requires access to the target Woolworths environment, configured Vertex credentials, Playwright browsers and the chosen Appium device or BrowserStack session.
