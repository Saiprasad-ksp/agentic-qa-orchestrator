# Generic runtime v2

This refactor starts from the working deterministic-authentication baseline.

## Preserved
- Same-browser deterministic UAT authentication in the MCP execution browser.
- Existing visual snapshots, baselines, comparisons, diffs and overlays.
- Existing screenshots, videos, traces, HTML/JSON reports and discovery protections.
- GitHub Actions, BrowserStack, Appium and existing scenario lifecycle commands.
- Gemini/Vertex execution authentication.
- Ollama remains outside the live execution runtime and may be used by local authoring scripts only.

## Runtime change
CHAT_DELTA now captures scenario-independent structured UI state. Playwright assigns ephemeral runtime IDs to visible controls and inputs while retaining real locators and unredacted values locally. Gemini returns one generic action: CLICK, TYPE, SEND_MESSAGE, WAIT, COMPLETE or FAIL. Playwright executes by runtime ID and captures the next state. No reorder, refund, order-selection or add-to-cart state is encoded in the runtime.

## Visual regression
`scenarios/web/aem-pages-visual-regression.txt` adds fourteen AEM Help pages. It uses the existing visual tools and environment base URL so UAT and PROD retain separate baselines and report evidence.

## Validation boundary
Static checks and smoke tests run without private credentials. Live UAT, BrowserStack, Appium and Vertex integration must be run in the user's configured environment.
