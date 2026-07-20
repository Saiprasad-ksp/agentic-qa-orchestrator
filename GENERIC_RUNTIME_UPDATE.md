# Generic Runtime Update

This patch is scenario-independent. It adds:

- combined CHAT and PAGE structured state capture;
- generic runtime actions by scoped element ID;
- page-level verification capability for any scenario;
- run-scoped screenshots, metrics, transcripts, videos and reports;
- automatic Playwright video finalisation;
- automatic scenario-derived generative report generation;
- report evidence restricted to the current run directory.

No scenario labels, cart selectors, order values, URLs, or recovery phrases are embedded in the framework.

## Apply

Extract over the current repository branch, then run:

```bash
npm install
npm test
npm run check
```

## Run

Use the existing discovery command. Each execution writes to:

```text
reports/runs/<scenario>/<run-id>/
```

The directory contains metrics, transcript, screenshots, videos, and the shareable HTML report.

Set `RECORD_VIDEO=false` to disable local Playwright video recording.
Set `CAPTURE_RUNTIME_SCREENSHOTS=false` to disable automatic post-action screenshots.
