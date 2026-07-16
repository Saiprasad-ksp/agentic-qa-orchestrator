# Migration notes: 1.x to 2.0

## Renamed

- Package: `gemini-qa-agent` → `agentic-qa-orchestrator`
- Version: `1.0.0` → `2.0.0`

## Main behavioural changes

- `scenario:build-and-run` is now the single end-to-end command.
- Scenario metadata determines web/mobile and deterministic/generative execution.
- Mobile execution supports Android and iOS through one `wdio.conf.js`.
- Generative tests use shared turn execution and semantic judging.
- Run evidence is created under `artifacts/runs/<run-id>`.
- Only the latest three run directories are retained by default.
- Generated specs are separated into `generated-specs/web` and `generated-specs/mobile`.
- Generated spec validation is platform- and test-type-aware.
- GitHub self-hosted execution is provided in `.github/workflows/qa-agent-local.yml`.

## Removed

- Historical backup source files.
- Duplicate root-level generated specs.
- Duplicate root-level scenario files.
- Local Gemini settings and captured one-off screenshots.
- The unused legacy `agent-runner.js` entry point.

## Existing compatibility

The current discovery runtime remains in `agent-hybrid-runtime.js` because it owns the MCP-driven real discovery flow. `agent-hybrid-client.js` remains a compatibility entry point that delegates to `scripts/run-discovery.js`.
