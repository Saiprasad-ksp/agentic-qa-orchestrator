const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { generateHtmlReport } = require('./generate-rich-report.js');
const { judgeChatbotResponse, decideNextAction, judgeStructuredOutcome, stateDelta } = require('./src/llmJudge');
const { loadProjectEnv, readEnv, requireEnv } = require('./src/env');
const { GoogleGenAI } = require('@google/genai');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

loadProjectEnv('.env.web', '.env.mobile', '.env.llm', '.env.browserstack');

if (process.env.GOOGLE_APPLICATION_CREDENTIALS && !path.isAbsolute(process.env.GOOGLE_APPLICATION_CREDENTIALS)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = path.resolve(__dirname, process.env.GOOGLE_APPLICATION_CREDENTIALS);
}

const scenariosDir = path.resolve(__dirname, 'scenarios');
const specsDir = path.resolve(__dirname, 'generated-specs');
const defaultReportsDir = path.resolve(__dirname, 'reports');
const configuredRunDir = String(process.env.QA_RUN_DIR || '').trim();
const reportsDir = configuredRunDir
  ? path.resolve(configuredRunDir)
  : defaultReportsDir;
const screenshotDir = path.resolve(reportsDir, 'screenshots');
const transcriptDir = path.resolve(reportsDir, 'transcripts');

for (const dir of [specsDir, reportsDir, screenshotDir, transcriptDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

const scenarioArg = process.argv[2];

if (!scenarioArg) {
  console.error('❌ Error: Please specify a scenario filename. Usage: node agent-hybrid-client.js <scenario-file-name.txt>');
  process.exit(1);
}

const scenarioPath = path.join(scenariosDir, scenarioArg);

if (!fs.existsSync(scenarioPath)) {
  console.error(`❌ Error: Scenario file not found: ${scenarioPath}`);
  process.exit(1);
}

const targetScenario = fs.readFileSync(scenarioPath, 'utf-8');
const baseName = path.basename(scenarioArg, '.txt');
const isWeb = targetScenario.toUpperCase().includes('PLATFORM: WEB');
const platformName = isWeb ? 'Web (local Playwright MCP server)' : 'Mobile (local Appium/WebdriverIO MCP server)';
const executionTarget = readEnv('RUN_TARGET', 'local').toLowerCase();
const isBrowserStack = executionTarget === 'browserstack';

const targetEnv = readEnv('TARGET_ENV', 'PROD').toUpperCase();
const isDiscoveryMode =
  readEnv('AGENT_RUN_MODE', 'execute').toLowerCase() === 'discover';

const targetBaseUrl = targetEnv === 'PROD'
  ? readEnv('URL_PROD', 'https://www.woolworths.com.au')
  : readEnv('URL_UAT', 'https://uatsite.woolworths.com.au');

function readScenarioValue(key) {
  const pattern = new RegExp(
    `^${key.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}:\\\\s*(.+)$`,
    'im'
  );

  return targetScenario.match(pattern)?.[1]?.trim() || '';
}

function resolveScenarioTargetUrl() {
  const explicitTargetUrl = readScenarioValue('TARGET_URL');
  const explicitTargetPath = readScenarioValue('TARGET_PATH');

  if (explicitTargetUrl) {
    return explicitTargetUrl;
  }

  if (explicitTargetPath) {
    const normalisedPath = explicitTargetPath.startsWith('/')
      ? explicitTargetPath
      : `/${explicitTargetPath}`;

    return `${targetBaseUrl.replace(/\/$/, '')}${normalisedPath}`;
  }

  const isHelpCenterScenario =
    /@helpcenter\\b/i.test(targetScenario) ||
    /^PAGE:\\s*Help Centre/im.test(targetScenario) ||
    /helpcenter|help-centre|help_centre|faq-audit/i.test(scenarioArg);

  if (isHelpCenterScenario) {
    return readEnv(
      'HELP_CENTER_WEB_URL',
      `${targetBaseUrl.replace(/\/$/, '')}/shop/help`
    );
  }

  return targetBaseUrl;
}

const targetUrl = resolveScenarioTargetUrl();

function createGeminiClient() {
  const authMode = readEnv('GEMINI_AUTH_MODE', 'api_key').toLowerCase();

  if (authMode === 'vertex') {
    const project = readEnv('GOOGLE_CLOUD_PROJECT') || readEnv('GCP_PROJECT_ID');
    const location = readEnv('GOOGLE_CLOUD_LOCATION') || readEnv('GCP_LOCATION', 'us-central1');

    if (!project) {
      throw new Error('GEMINI_AUTH_MODE=vertex requires GOOGLE_CLOUD_PROJECT or GCP_PROJECT_ID.');
    }

    if (!readEnv('GOOGLE_APPLICATION_CREDENTIALS')) {
      throw new Error('GEMINI_AUTH_MODE=vertex requires GOOGLE_APPLICATION_CREDENTIALS.');
    }

    return new GoogleGenAI({ vertexai: true, project, location });
  }

  return new GoogleGenAI({
    apiKey: requireEnv('GEMINI_API_KEY', 'Or configure Vertex AI in .env.llm.'),
  });
}

function cleanGeneratedCode(code) {
  return String(code || '')
    .replace(/^```(?:javascript|js|ts|typescript)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim() + '\n';
}

function getToolText(result) {
  if (!result || !Array.isArray(result.content)) return '';
  return result.content.map(item => item.text || '').filter(Boolean).join('\n');
}

function preview(value, max = 1800) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (!text) return '';
  return text.length > max ? `${text.slice(0, max)}\n...truncated...` : text;
}


function filterSpecGenerationTool(tools) {
  const availableTools = Array.isArray(tools) ? tools : [];
  const autoSaveSpec =
    readEnv('AUTO_SAVE_SPEC', 'false').toLowerCase() === 'true';

  const removeSpecTool = isDiscoveryMode || !autoSaveSpec;

  if (!removeSpecTool) {
    return availableTools;
  }

  return availableTools
    .map((tool) => {
      if (!tool || typeof tool !== 'object') {
        return tool;
      }

      if (tool.name === 'save_spec_file') {
        return null;
      }

      if (Array.isArray(tool.functionDeclarations)) {
        return {
          ...tool,
          functionDeclarations: tool.functionDeclarations.filter(
            (declaration) =>
              declaration &&
              declaration.name !== 'save_spec_file'
          ),
        };
      }

      return tool;
    })
    .filter(Boolean);
}

function extractScreenshotPaths(text) {
  const value = String(text || '');
  const paths = new Set();

  const jsonPathRegex = /"(?:actualPath|baselinePath|diffPath|screenshot|path)"\s*:\s*"([^"]+\.png)"/gi;
  let jsonMatch;
  while ((jsonMatch = jsonPathRegex.exec(value)) !== null) {
    paths.add(jsonMatch[1]);
  }

  const labelledLineRegex = /(?:Screenshot saved to|Screenshot:|Actual:|Baseline:|Diff:)\s*(.+?\.png)\s*$/gim;
  let labelledMatch;
  while ((labelledMatch = labelledLineRegex.exec(value)) !== null) {
    paths.add(labelledMatch[1].trim());
  }

  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('/') && trimmed.endsWith('.png')) {
      paths.add(trimmed);
    }
  }

  return [...paths];
}

function parseToolJson(text) {
  try {
    return JSON.parse(text);
  } catch (_) {
    const match = String(text || '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (__) {
      return null;
    }
  }
}

function mcpTransportConfig() {
  const mode = readEnv('MCP_SERVER_MODE', 'local').toLowerCase();

  /*
   * StdioClientTransport does not automatically forward every custom
   * environment variable. Explicitly pass the parent environment so the
   * MCP server receives runner settings, BrowserStack credentials, URL
   * configuration and Olive timeout values.
   */
  const childEnv = Object.fromEntries(
    Object.entries(process.env)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => [key, String(value)])
  );

  if (mode === 'official') {
    return {
      command: 'npx',
      args: isWeb
        ? ['-y', '@playwright/mcp@latest']
        : ['-y', 'appium-mcp@latest'],
      stderr: 'inherit',
      env: childEnv,
    };
  }

  return {
    command: process.execPath,
    args: [
      path.resolve(
        __dirname,
        isWeb
          ? 'mcp-server.js'
          : 'mcp-mobile-server.js'
      ),
    ],
    stderr: 'inherit',
    env: childEnv,
  };
}

function recordLlmMetadata(metrics, metadata, turnLabel) {
  if (!metadata) return;

  const event = {
    turn: turnLabel || metadata.stage || 'LLM call',
    stage: metadata.stage || turnLabel || 'LLM call',
    provider: metadata.provider || 'gemini',
    model: metadata.model || metrics.model,
    temperature: Number(metadata.temperature ?? metrics.llmTemperature ?? 0),
    maxOutputTokens: Number(metadata.maxOutputTokens || 0),
    attempt: Number(metadata.attempt || 1),
    finishReason: metadata.finishReason || 'UNKNOWN',
    promptTokenCount: Number(metadata.promptTokenCount || 0),
    candidatesTokenCount: Number(metadata.candidatesTokenCount || 0),
    totalTokenCount: Number(metadata.totalTokenCount || 0),
    cachedContentTokenCount: Number(metadata.cachedContentTokenCount || 0),
    durationMs: Number(metadata.durationMs || 0),
    requestPayload: metadata.requestPayload || '',
    responsePayload: metadata.responsePayload || '',
  };

  metrics.tokenEvents.push(event);
  metrics.totalTokens += event.totalTokenCount;
}

function recordUsage(metrics, response, turnLabel) {
  const usage = response?.usageMetadata;
  if (!usage) return;

  recordLlmMetadata(metrics, {
    stage: turnLabel,
    model: metrics.model,
    temperature: metrics.llmTemperature,
    maxOutputTokens: metrics.maxOutputTokens,
    ...usage,
  }, turnLabel);
}

function findRuntimeLabel(state, scope, targetId) {
  const surface = String(scope || 'CHAT').toUpperCase() === 'PAGE'
    ? state?.page
    : (state?.chat || state);
  const items = [...(surface?.controls || []), ...(surface?.inputs || [])];
  const match = items.find(item => item?.id === targetId);
  return match?.label || match?.placeholder || targetId || '';
}

function meaningfulNewMessages(previousState, currentState) {
  const beforeSurface = previousState?.chat || previousState || {};
  const currentSurface = currentState?.chat || currentState || {};
  const before = new Set((beforeSurface.messages || [])
    .map(item => String(item?.text || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean));
  return (currentSurface.messages || [])
    .map(item => String(item?.text || '').replace(/\s+/g, ' ').trim())
    .filter(text => text && !before.has(text) && !/^Sent\s+\d/i.test(text));
}

function attachScreenshots(metrics, outputText) {
  for (const shotPath of extractScreenshotPaths(outputText)) {
    if (!fs.existsSync(shotPath)) continue;

    const exists = metrics.screenshots.some(s => s.path === shotPath);
    if (exists) continue;

    metrics.screenshots.push({
      label: path.basename(shotPath),
      path: shotPath,
      base64: fs.readFileSync(shotPath, 'base64'),
    });
  }
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function buildRunMetrics() {
  return {
    scenarioName: baseName,
    platform: platformName,
    executionTarget: executionTarget.toUpperCase(),
    targetUrl,
    model: readEnv('GEMINI_MODEL', 'gemini-2.5-flash'),
    llmTemperature: Number(readEnv('RUNTIME_LLM_TEMPERATURE', '0.1')),
    maxOutputTokens: Number(readEnv('RUNTIME_MAX_OUTPUT_TOKENS', '1200')),
    llmAuthMode: readEnv('GEMINI_AUTH_MODE', 'api_key'),
    headless: process.env.HEADLESS !== 'false',
    startedAt: new Date().toISOString(),
    endedAt: null,
    durationMs: 0,
    totalTokens: 0,
    steps: [],
    validations: [],
    tokenEvents: [],
    screenshots: [],
    visualComparisons: [],
    savedSpecPath: null,
    metricsJsonPath: null,
    transcriptJsonPath: null,
    transcript: [],
    conversationTurns: [],
    judgements: [],
  };
}

function readScenarioHeader(text, key, fallback = '') {
  const pattern = new RegExp(
    `^${key.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}:\\s*(.+)$`,
    'im',
  );

  const match = String(text || '').match(pattern);
  return match ? match[1].trim() : fallback;
}

function resolveExecutionMode(text) {
  return readScenarioHeader(
    text,
    'EXECUTION_MODE',
    'AGENTIC',
  ).toUpperCase();
}



function summariseToolOutput(name, parsed, output) {
  if (!parsed || typeof parsed !== 'object') {
    return preview(output, 500);
  }

  if (name === 'pw_capture_runtime_state') {
    const chat = parsed.chat || {};
    const page = parsed.page || {};
    return [
      `chat(messages=${chat.messages?.length || 0}, controls=${chat.controls?.length || 0}, inputs=${chat.inputs?.length || 0})`,
      `page(controls=${page.controls?.length || 0}, inputs=${page.inputs?.length || 0}, text=${page.text?.length || 0})`,
      page.url ? `url=${page.url}` : '',
    ].filter(Boolean).join(' | ');
  }

  if (name === 'pw_execute_runtime_action') {
    return `executed=${parsed.executed !== false} scope=${parsed.scope || '-'} action=${parsed.action || '-'} target=${parsed.targetId || '-'}`;
  }

  if (name === 'pw_finalize_run') {
    return `finalised=${Boolean(parsed.finalised)} videos=${parsed.videoFiles?.length || 0} screenshots=${parsed.screenshotFiles?.length || 0}`;
  }

  return preview(JSON.stringify(parsed), 700);
}

async function callMcpDirect(
  mcpClient,
  metrics,
  name,
  args,
  turn
) {
  const startedAt = Date.now();

  console.log(
    `\n[Turn ${turn}] 🎭 Runtime -> ${name}`
  );

  if (
    args &&
    Object.keys(args).length
  ) {
    console.log(
      `👉 Args: ${JSON.stringify(args)}`
    );
  }

  const authenticatedNavigation =
    name === 'pw_navigate' &&
    String(
      process.env.MCP_DETERMINISTIC_AUTH || ''
    ).toLowerCase() === 'true';

  const oliveLongRunningTool =
    name === 'pw_send_olive_message' ||
    name === 'pw_click_button' ||
    name === 'pw_execute_olive_action';

  const timeoutMs =
    authenticatedNavigation
      ? Number(
          process.env.MCP_AUTH_TOOL_TIMEOUT_MS ||
          180000
        )
      : oliveLongRunningTool
        ? Number(
            process.env.MCP_OLIVE_TOOL_TIMEOUT_MS ||
            120000
          )
        : Number(
            process.env.MCP_TOOL_TIMEOUT_MS ||
            60000
          );

  console.log(
    `⏱️ MCP timeout for ${name}: ${timeoutMs}ms`
  );

  const result =
    await mcpClient.callTool(
      {
        name,
        arguments: args || {},
      },
      undefined,
      {
        timeout: timeoutMs,
      }
    );

  const output =
    getToolText(result);

  const failed =
    Boolean(result.isError);

  const parsedOutput =
    parseToolJson(output);

  if (readEnv('RUNTIME_LOG_LEVEL', 'summary') === 'raw') {
    console.log(output.slice(0, 2500));
  } else {
    console.log(`↳ ${summariseToolOutput(name, parsedOutput, output)}`);
  }

  attachScreenshots(
    metrics,
    output
  );

  metrics.steps.push({
    turn,
    name,
    status: failed
      ? 'FAILED'
      : 'SUCCESS',
    durationMs:
      Date.now() - startedAt,
    argsPreview:
      preview(args || {}),
    outputPreview:
      preview(output),
  });

  return {
    output,
    failed,
    parsed:
      parsedOutput,
  };
}

function redactChatStateForPlanner(value) {
  return String(value || '')
    .replace(
      /\b\d{6,}\b/g,
      '[REDACTED_ID]'
    )
    .replace(
      /\b[A-Z0-9]{8,}\b/g,
      '[REDACTED_ID]'
    )
    .slice(
      0,
      Number(
        readEnv(
          'MAX_CHATBOT_RESPONSE_CHARS',
          '2500'
        )
      )
    );
}

async function getChatDeltaDecision(
  ai,
  model,
  scenarioText,
  state
) {
  const prompt = `
You are a business-flow planner.

You do not control the browser.
You cannot call tools.

Return JSON only using this schema:

{
  "action": "SEND_MESSAGE|CLICK_CONTROL|TAKE_SCREENSHOT|COMPLETE|FAIL",
  "value": "string",
  "expectedIntent": "string",
  "acceptanceCriteria": ["string"],
  "reason": "string"
}

Rules:

- CLICK_CONTROL values must be visible semantic labels only.
- Never return CSS selectors.
- Never return Playwright or MCP tool names.
- Never return credentials.
- Never return order references.
- Never return customer identifiers.
- Never return executable code.
- Choose COMPLETE only after all mandatory scenario outcomes have been observed.
- Choose FAIL when authentication is required, the flow is stuck, required data is unavailable, or a mandatory branch cannot continue.

SCENARIO:

${scenarioText}

CURRENT STATE:

${JSON.stringify(state)}
`;

  const response =
    await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        temperature: 0.1,
        responseMimeType:
          'application/json',
      },
    });

  const raw =
    response.text ||
    response.candidates?.[0]
      ?.content?.parts
      ?.map(part => part.text || '')
      .join('') ||
    '';

  const parsed =
    parseToolJson(raw);

  if (
    !parsed ||
    !parsed.action
  ) {
    throw new Error(
      `CHAT_DELTA planner returned invalid JSON: ${preview(raw, 500)}`
    );
  }

  return {
    decision: parsed,
    response,
  };
}

async function finaliseChatDeltaRun({
  metrics,
  runStartMs,
  mcpClient,
  testFailed,
  failureReason,
}) {
  metrics.endedAt =
    new Date().toISOString();

  metrics.durationMs =
    Date.now() - runStartMs;

  metrics.failureReason =
    failureReason || null;

  try {
    const finalised = await callMcpDirect(
      mcpClient,
      metrics,
      'pw_finalize_run',
      {},
      metrics.steps.length + 1
    );
    if (finalised?.parsed) {
      metrics.runtimeArtifacts = finalised.parsed;
      metrics.artifacts = [
        ...(Array.isArray(metrics.artifacts) ? metrics.artifacts : []),
        ...(finalised.parsed.videoFiles || []),
        ...(finalised.parsed.screenshotFiles || []),
      ];
    }
  } catch (error) {
    console.warn(`⚠️ Runtime finalisation warning: ${error.message}`);
  }

  const transcriptPath =
    path.join(
      transcriptDir,
      `${baseName}.transcript.json`
    );

  const metricsJsonPath =
    path.join(
      reportsDir,
      `${baseName}.metrics.json`
    );

  metrics.transcriptJsonPath =
    transcriptPath;

  metrics.metricsJsonPath =
    metricsJsonPath;

  writeJson(
    transcriptPath,
    metrics.transcript
  );

  writeJson(
    metricsJsonPath,
    metrics
  );

  try {
    fs.writeFileSync(
      path.join(
        reportsDir,
        `${baseName}.report.html`
      ),
      generateHtmlReport({
        scenarioName: baseName,
        metrics,
      }),
      'utf-8'
    );

    console.log(
      `📊 HTML report saved: reports/${baseName}.report.html`
    );

    console.log(
      `📄 Metrics JSON saved: reports/${baseName}.metrics.json`
    );

    console.log(
      `🧾 Transcript JSON saved: reports/transcripts/${baseName}.transcript.json`
    );
  } catch (error) {
    console.error(
      `⚠️ Failed to generate report: ${error.message}`
    );
  }

  console.log('');
  console.log(
    '🔎 CHAT_DELTA completion summary'
  );

  console.log(
    `• Runtime-controlled steps: ${metrics.steps.length}`
  );

  console.log(
    `• Application assertions: ${
      testFailed
        ? 'FAILED'
        : 'PASSED'
    }`
  );

  if (failureReason) {
    console.log(
      `• Failure reason: ${failureReason}`
    );
  }

  try {
    await mcpClient.close();
  } catch (_) {
    // Ignore shutdown errors.
  }

  process.exit(
    testFailed
      ? 1
      : 0
  );
}


function normaliseControlLabel(value) {
  return String(value || '')
    .replace(/^text:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function resolveRuntimeControlText(
  requestedValue,
  latest
) {
  const requested =
    normaliseControlLabel(
      requestedValue
    );

  if (!requested) {
    return '';
  }

  /*
   * Named runtime placeholders are intentionally resolved inside
   * Playwright, where the real customer value remains private.
   */
  if (
    /\[(?:PRIMARY|SECONDARY)_RUNTIME_ORDER_NUMBER\]/i.test(
      requested
    )
  ) {
    return requested;
  }

  const candidates = [];

  if (
    Array.isArray(
      latest?.newBotMessages
    )
  ) {
    candidates.push(
      ...latest.newBotMessages
    );
  }

  if (latest?.botResponse) {
    candidates.push(
      ...String(
        latest.botResponse
      ).split('\n')
    );
  }

  const uniqueCandidates =
    [...new Set(
      candidates
        .map(normaliseControlLabel)
        .filter(Boolean)
    )];

  /*
   * First try exact local text. This supports controls that do
   * not contain customer-specific identifiers.
   */
  const exact =
    uniqueCandidates.find(
      candidate =>
        candidate === requested
    );

  if (exact) {
    return exact;
  }

  /*
   * The planner receives redacted values. Compare each real
   * runtime candidate after applying the same redaction.
   */
  const redactedMatch =
    uniqueCandidates.find(
      candidate =>
        normaliseControlLabel(
          redactChatStateForPlanner(
            candidate
          )
        ) === requested
    );

  if (redactedMatch) {
    console.log(
      '🔐 Resolved redacted planner control to its runtime-only UI value.'
    );

    return redactedMatch;
  }

  /*
   * Defensive fallback for planner formatting differences around
   * the [REDACTED_ID] token.
   */
  if (
    requested.includes(
      '[REDACTED_ID]'
    )
  ) {
    const [
      prefix,
      suffix = '',
    ] =
      requested.split(
        '[REDACTED_ID]'
      );

    const partialMatch =
      uniqueCandidates.find(
        candidate =>
          candidate.startsWith(
            prefix.trim()
          ) &&
          (
            !suffix.trim() ||
            candidate.endsWith(
              suffix.trim()
            )
          )
      );

    if (partialMatch) {
      console.log(
        '🔐 Resolved redacted planner control using local prefix/suffix matching.'
      );

      return partialMatch;
    }
  }

  return requested;
}

async function executeChatDeltaFlow({
  scenarioText,
  mcpClient,
  metrics,
  runStartMs,
}) {
  const maxTurns =
    Number(
      readScenarioHeader(
        targetScenario,
        'MAX_CUSTOMER_TURNS',
        '25'
      )
    );

  const maxNoProgressTurns =
    Number(
      process.env
        .MAX_NO_PROGRESS_TURNS ||
      3
    );

  let runtimeTurn = 0;
  let testFailed = false;
  let failureReason = '';
  let completed = false;

  const history = [];

  const memory = {
    conversationSummary: '',
    goalStatus:
      'IN_PROGRESS',
    completedProgress: [],
    unresolvedRequests: [],
    noProgressTurns: 0,
    lastState: null,
  };

  const normaliseSurface = surface => ({
    ready: Boolean(surface?.surfaceReady ?? surface?.ready),
    busy: Boolean(surface?.busy),
    url: String(surface?.url || ''),
    messages: (surface?.messages || [])
      .slice(-8)
      .map(message => String(message?.text || '').replace(/\s+/g, ' ').trim()),
    controls: (surface?.controls || [])
      .filter(control => control?.enabled !== false)
      .map(control => ({
        id: control.id,
        type: control.type,
        label: String(control.label || '').replace(/\s+/g, ' ').trim(),
      })),
    inputs: (surface?.inputs || [])
      .filter(input => input?.enabled !== false)
      .map(input => ({
        id: input.id,
        type: input.type,
        placeholder: String(input.placeholder || '').replace(/\s+/g, ' ').trim(),
      })),
    text: (surface?.text || []).slice(-30),
  });

  const normaliseStateForSignature = state => ({
    chat: normaliseSurface(state?.chat || state),
    page: normaliseSurface(state?.page || {}),
  });

  const stateSignature =
    state =>
      JSON.stringify(
        normaliseStateForSignature(
          state
        )
      );

  let previousSignature = '';

  try {
    runtimeTurn += 1;

    let toolResult =
      await callMcpDirect(
        mcpClient,
        metrics,
        'pw_navigate',
        {
          url: targetUrl,
        },
        runtimeTurn
      );

    if (toolResult.failed) {
      throw new Error(
        'Navigation failed.'
      );
    }

    runtimeTurn += 1;

    toolResult =
      await callMcpDirect(
        mcpClient,
        metrics,
        'pw_open_olive',
        {},
        runtimeTurn
      );

    if (toolResult.failed) {
      throw new Error(
        'Unable to open Olive.'
      );
    }

    for (
      let customerTurn = 1;
      customerTurn <= maxTurns;
      customerTurn += 1
    ) {
      runtimeTurn += 1;

      const capture =
        await callMcpDirect(
          mcpClient,
          metrics,
          'pw_capture_runtime_state',
          {},
          runtimeTurn
        );

      if (
        capture.failed ||
        !capture.parsed
      ) {
        throw new Error(
          'Structured runtime state capture failed.'
        );
      }

      const previousState =
        capture.parsed;

      const action =
        await decideNextAction({
          scenario:
            scenarioText,
          state:
            previousState,
          history,
          memory,
        });

      recordLlmMetadata(
        metrics,
        action._llm,
        `Planner turn ${customerTurn}`
      );
      delete action._llm;

      console.log(
        `🧠 Planner: ` +
        `${action.action}` +
        `${
          action.targetId
            ? ` ${action.targetId}`
            : ''
        } — ${action.reason}`
      );

      if (
        action.conversationSummary
      ) {
        memory.conversationSummary =
          action.conversationSummary;
      }

      if (
        action.goalStatus
      ) {
        memory.goalStatus =
          action.goalStatus;
      }

      if (
        action.action ===
        'COMPLETE'
      ) {
        /*
         * Planner completion is accepted only when it refers to
         * visible state. Record it as the final decision.
         */
        completed = true;

        history.push({
          turn:
            customerTurn,
          action,
          stateSummary:
            normaliseStateForSignature(
              previousState
            ),
        });

        break;
      }

      if (
        action.action === 'FAIL'
      ) {
        throw new Error(
          action.reason ||
          'Planner reported an application failure.'
        );
      }

      runtimeTurn += 1;

      const execution =
        await callMcpDirect(
          mcpClient,
          metrics,
          'pw_execute_runtime_action',
          {
            action:
              action.action,
            scope:
              action.scope || 'CHAT',
            targetId:
              action.targetId || '',
            value:
              action.value || '',
            waitMs:
              action.waitMs || 0,
            reason:
              action.reason || '',
          },
          runtimeTurn
        );

      if (execution.failed) {
        throw new Error(
          `Action ${action.action} failed.`
        );
      }

      /*
       * Browser and chatbot UIs frequently render in multiple asynchronous
       * phases. Keep polling locally and call Gemini only after a meaningful
       * state change has remained stable. This avoids judging an intermediate
       * empty state and does not consume additional LLM tokens while polling.
       */
      const settleTimeoutMs = Number(
        process.env.RUNTIME_STATE_SETTLE_TIMEOUT_MS ||
        process.env.OLIVE_POST_ACTION_SETTLE_TIMEOUT_MS ||
        65000
      );
      const settlePollIntervalMs = Number(
        process.env.RUNTIME_STATE_POLL_INTERVAL_MS ||
        750
      );
      const requiredStablePolls = Math.max(
        2,
        Number(process.env.RUNTIME_STATE_STABLE_POLLS || 2)
      );
      const blockedMinWaitMs = Number(
        process.env.RUNTIME_BLOCKED_MIN_WAIT_MS ||
        15000
      );

      const beforeActionSignature = stateSignature(previousState);
      const settleStartedAt = Date.now();
      const settleDeadline = settleStartedAt + settleTimeoutMs;

      let currentState = null;
      let lastCapturedState = null;
      let lastCapturedSignature = '';
      let stablePolls = 0;
      let meaningfulChangeSeen = false;
      let captureCount = 0;

      while (Date.now() < settleDeadline) {
        runtimeTurn += 1;
        captureCount += 1;

        const nextCapture = await callMcpDirect(
          mcpClient,
          metrics,
          'pw_capture_runtime_state',
          {},
          runtimeTurn
        );

        if (nextCapture.failed || !nextCapture.parsed) {
          throw new Error('Post-action runtime state capture failed.');
        }

        const candidateState = nextCapture.parsed;
        const candidateSignature = stateSignature(candidateState);
        const changedFromBefore = candidateSignature !== beforeActionSignature;
        const runtimeBusy = [candidateState.chat, candidateState.page]
          .filter(Boolean)
          .some(surface => surface.busy === true);

        meaningfulChangeSeen = meaningfulChangeSeen || changedFromBefore;
        lastCapturedState = candidateState;

        if (candidateSignature === lastCapturedSignature) {
          stablePolls += 1;
        } else {
          lastCapturedSignature = candidateSignature;
          stablePolls = 1;
        }

        const waitedMs = Date.now() - settleStartedAt;
        const stableAfterMeaningfulChange =
          meaningfulChangeSeen &&
          !runtimeBusy &&
          stablePolls >= requiredStablePolls;
        const timedOutAfterMinimumWait =
          waitedMs >= blockedMinWaitMs &&
          Date.now() + settlePollIntervalMs >= settleDeadline;

        if (stableAfterMeaningfulChange || timedOutAfterMinimumWait) {
          currentState = candidateState;
          break;
        }

        await new Promise(resolve =>
          setTimeout(resolve, settlePollIntervalMs)
        );
      }

      currentState = currentState || lastCapturedState;

      if (!currentState) {
        throw new Error('No post-action runtime state was captured.');
      }

      const settleEvidence = {
        captureCount,
        waitedMs: Date.now() - settleStartedAt,
        meaningfulChangeSeen,
        stablePolls,
        requiredStablePolls,
      };

      console.log(
        `⏳ State settled after ${settleEvidence.waitedMs}ms ` +
        `(${settleEvidence.captureCount} captures, ` +
        `stable=${settleEvidence.stablePolls}/${settleEvidence.requiredStablePolls}, ` +
        `changed=${settleEvidence.meaningfulChangeSeen ? 'YES' : 'NO'})`
      );

      const currentSignature =
        stateSignature(
          currentState
        );

      const observableStateChanged =
        currentSignature !==
        previousSignature;

      const judgement =
        await judgeStructuredOutcome({
          scenario:
            scenarioText,
          previousState,
          action,
          result:
            execution.parsed || {
              executed: true,
            },
          currentState,
          memory,
        });

      recordLlmMetadata(
        metrics,
        judgement._llm,
        `Judge turn ${customerTurn}`
      );
      const judgeLlm = judgement._llm || null;
      delete judgement._llm;

      const customerActionLabel = findRuntimeLabel(
        previousState,
        action.scope,
        action.targetId
      );
      const userMessage = action.action === 'SEND_MESSAGE' || action.action === 'TYPE'
        ? String(action.value || '')
        : customerActionLabel;
      const botMessages = meaningfulNewMessages(previousState, currentState);
      const delta = stateDelta(previousState, currentState, scenarioText);

      metrics.judgements.push(judgement);
      metrics.validations.push({
        turn: customerTurn,
        passed: judgement.passed,
        complete: judgement.complete,
        goalStatus: judgement.goalStatus,
        madeProgress: judgement.madeProgress,
        score: judgement.score,
        reason: judgement.reason,
        summary: judgement.reason,
        userMessage,
        customerAction: {
          scope: action.scope,
          action: action.action,
          targetId: action.targetId || '',
          label: customerActionLabel,
          value: action.action === 'SEND_MESSAGE' || action.action === 'TYPE'
            ? String(action.value || '')
            : '',
        },
        botResponse: botMessages.join('\n'),
        botMessages,
        expectedIntent: action.expectedProgress || '',
        intentMatched: judgement.goalStatus !== 'FAILED',
        safe: true,
        detectedState: judgement.goalStatus,
        judgeMode: 'llm_structured',
        evidence: Array.isArray(judgement.evidence) ? judgement.evidence : [],
        issues: judgement.passed ? [] : [judgement.reason],
        stateDelta: delta,
        settleEvidence,
        llm: judgeLlm ? {
          model: judgeLlm.model,
          temperature: judgeLlm.temperature,
          promptTokenCount: judgeLlm.promptTokenCount,
          candidatesTokenCount: judgeLlm.candidatesTokenCount,
          cachedContentTokenCount: judgeLlm.cachedContentTokenCount,
          totalTokenCount: judgeLlm.totalTokenCount,
          finishReason: judgeLlm.finishReason,
          requestPayload: judgeLlm.requestPayload,
          responsePayload: judgeLlm.responsePayload,
        } : null,
      });

      memory.conversationSummary =
        judgement
          .conversationSummary ||
        memory.conversationSummary;

      memory.goalStatus =
        judgement.goalStatus ||
        'IN_PROGRESS';

      memory.completedProgress =
        Array.isArray(
          judgement.completedProgress
        )
          ? judgement
              .completedProgress
          : memory
              .completedProgress;

      memory.unresolvedRequests =
        Array.isArray(
          judgement.unresolvedRequests
        )
          ? judgement
              .unresolvedRequests
          : memory
              .unresolvedRequests;

      const judgeMadeProgress = judgement.madeProgress === true;
      const madeProgress = judgeMadeProgress || observableStateChanged;

      if (madeProgress) {
        memory.noProgressTurns = 0;
      } else {
        memory.noProgressTurns += 1;
      }

      history.push({
        turn:
          customerTurn,
        action,
        expectedProgress:
          action.expectedProgress,
        judgement,
        stateSummary:
          normaliseStateForSignature(
            currentState
          ),
      });

      previousSignature =
        currentSignature;
      memory.lastState = currentState;

      console.log(
        `🧪 Judge: ` +
        `${judgement.goalStatus}` +
        ` / progress=${
          madeProgress
            ? 'YES'
            : 'NO'
        } — ${judgement.reason}`
      );

      if (
        judgement.goalStatus ===
        'COMPLETE'
      ) {
        completed = true;
        break;
      }

      if (
        judgement.goalStatus ===
        'FAILED'
      ) {
        /*
         * An LLM statement such as "Olive failed to acknowledge"
         * is not application evidence. Failure must be supported
         * by text currently visible in the application.
         */
        const visibleApplicationText =
          [
            ...((currentState.chat?.messages || currentState.messages || []))
              .map(message =>
                String(
                  message?.text || ''
                )
              ),
          ]
            .join(' ')
            .replace(/\s+/g, ' ')
            .trim();

        const explicitApplicationFailure =
          /\b(?:something went wrong|technical error|system error|unable to complete|cannot complete|can't complete|could not complete|service unavailable|try again later|not eligible|request declined|request denied)\b/i
            .test(
              visibleApplicationText
            );

        const shellControlPattern =
          /^(?:minimise(?: the chat)?|close(?: the chat)?|send|start voice input|privacy policy|collection notice)$/i;

        const actionableBusinessControls =
          ([...(currentState.chat?.controls || currentState.controls || []), ...(currentState.page?.controls || [])])
            .filter(control =>
              control?.enabled !== false
            )
            .filter(control =>
              !shellControlPattern.test(
                String(
                  control?.label || ''
                ).trim()
              )
            );

        const usableInputs =
          ([...(currentState.chat?.inputs || currentState.inputs || []), ...(currentState.page?.inputs || [])])
            .filter(input =>
              input?.enabled !== false
            );

        /*
         * An enabled business control or usable input means the
         * conversation can continue. It cannot be classified as
         * FAILED merely because an expected sentence is absent.
         */
        const conversationCanContinue =
          actionableBusinessControls.length > 0 ||
          usableInputs.length > 0;

        if (
          explicitApplicationFailure &&
          !conversationCanContinue
        ) {
          throw new Error(
            judgement.reason ||
            'Application failure was detected.'
          );
        }

        console.warn(
          '⚠️ Judge returned FAILED without explicit application ' +
          'failure evidence. Continuing as IN_PROGRESS.'
        );

        judgement.goalStatus =
          'IN_PROGRESS';

        judgement.passed = true;
        judgement.complete = false;
        judgement.shouldContinue = true;

        judgement.reason =
          conversationCanContinue
            ? 'The application still presents an actionable control or input, so the conversation can continue.'
            : 'No explicit application failure is visible. Waiting for further conversational progress.';

        memory.goalStatus =
          'IN_PROGRESS';
      }

      if (
        judgement.goalStatus ===
        'BLOCKED'
      ) {
        const shellControlPattern =
          /^(?:minimise(?: the chat)?|close(?: the chat)?|send|start voice input|privacy policy|collection notice)$/i;
        const actionableControls = [
          ...(currentState.chat?.controls || currentState.controls || []),
          ...(currentState.page?.controls || []),
        ].filter(control =>
          control?.enabled !== false &&
          !shellControlPattern.test(String(control?.label || '').trim())
        );
        const usableInputs = [
          ...(currentState.chat?.inputs || currentState.inputs || []),
          ...(currentState.page?.inputs || []),
        ].filter(input => input?.enabled !== false);
        const trulyBlocked =
          settleEvidence.waitedMs >= blockedMinWaitMs &&
          !settleEvidence.meaningfulChangeSeen &&
          actionableControls.length === 0 &&
          usableInputs.length === 0;

        if (trulyBlocked) {
          throw new Error(
            judgement.reason ||
            'Conversation is blocked after the full settling period.'
          );
        }

        console.warn(
          '⚠️ Judge returned BLOCKED before conclusive application evidence. ' +
          'Continuing as IN_PROGRESS.'
        );
        judgement.goalStatus = 'IN_PROGRESS';
        judgement.passed = true;
        judgement.complete = false;
        judgement.shouldContinue = true;
        judgement.reason =
          'The application changed or still provides an actionable control/input; ' +
          'the runtime will continue rather than treating a transient state as blocked.';
        memory.goalStatus = 'IN_PROGRESS';
      }

      /*
       * A single unexpected or unchanged response is not a failure.
       * Fail only after repeated turns with no observable or semantic
       * progress.
       */
      if (
        memory.noProgressTurns >=
        maxNoProgressTurns
      ) {
        throw new Error(
          `Conversation made no progress for ` +
          `${memory.noProgressTurns} consecutive turns. ` +
          `${judgement.reason || ''}`.trim()
        );
      }
    }

    if (!completed) {
      throw new Error(
        `Scenario did not complete within ` +
        `${maxTurns} customer turns.`
      );
    }
  } catch (error) {
    testFailed = true;
    failureReason =
      error.message;

    console.error(
      `❌ CHAT_DELTA failure: ` +
      `${error.stack || error.message}`
    );
  }

  return finaliseChatDeltaRun({
    metrics,
    runStartMs,
    mcpClient,
    testFailed,
    failureReason,
  });
}

async function executeGenerativeFlow(scenarioText) {
  const executionMode = resolveExecutionMode(scenarioText);

  console.log(`🧭 Execution mode: ${executionMode}`);

  console.log(
    `\n🚀 Initialising ${
      process.env.BOT_NAME ||
      process.env.QA_BOT_NAME ||
      'chatbot'
    } generative QA agent...`
  );
  console.log(`⚙️  Platform: ${platformName}`);
  console.log(`🎯 Execution target: ${executionTarget.toUpperCase()}`);
  if (isWeb) console.log(`🌍 URL: ${targetUrl}`);

  const metrics = buildRunMetrics();
  const runStartMs = Date.now();

  const transport = new StdioClientTransport(mcpTransportConfig());
  const mcpClient = new Client(
    { name: 'olive-qa-mcp-client', version: '5.0.0' },
    { capabilities: {} },
  );

  await mcpClient.connect(transport);

  if (executionMode === 'CHAT_DELTA') {
    return executeChatDeltaFlow({
      scenarioText,
      mcpClient,
      metrics,
      runStartMs,
    });
  }

  const mcpTools = await mcpClient.listTools();

  const geminiTools = mcpTools.tools.map(tool => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
  }));

  geminiTools.push({
    name: 'verify_generative_response',
    description: 'LLM-as-a-judge semantic validation for Olive chatbot responses. Use this instead of exact text matching for generative responses.',
    parameters: {
      type: 'object',
      properties: {
        userMessage: { type: 'string' },
        botResponse: { type: 'string' },
        expectedIntent: { type: 'string' },
        acceptanceCriteria: { type: 'array', items: { type: 'string' } },
        blockedPatterns: { type: 'array', items: { type: 'string' } },
        currentState: { type: 'string' },
        allowedNextStates: { type: 'array', items: { type: 'string' } },
        flowId: { type: 'string' },
        flowContext: { type: 'object' },
      },
      required: ['userMessage', 'botResponse', 'expectedIntent'],
    },
  });

  geminiTools.push({
    name: 'save_spec_file',
    description: 'Write the final deterministic Playwright or WebdriverIO spec to generated-specs.',
    parameters: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Optional filename ending with .spec.js. Defaults to the scenario name.',
        },
        codeContent: {
          type: 'string',
          description: 'Complete executable JavaScript spec code.',
        },
      },
      required: ['codeContent'],
    },
  });

  const ai = createGeminiClient();
  const model = readEnv('GEMINI_MODEL', 'gemini-2.5-flash');

  const systemInstruction = `
You are an expert autonomous QA engineering agent for Woolworths Olive.

Use MCP tools to execute the scenario. Do not invent tool results.

Critical rules:
- Use semantic validation for generative Olive answers. Never exact-match full chatbot responses.
- For web Olive tests, use this order: pw_navigate -> pw_open_olive -> pw_send_olive_message -> verify_generative_response.
- When pw_send_olive_message returns JSON, extract botResponse and pass it to verify_generative_response.
- Never send fullConversation, whole-page text, or unrelated page controls back to Gemini.
- Treat login, order selection, item selection, and escalation as valid intermediate states when allowed by the scenario or flow context.
${isDiscoveryMode
  ? `- DISCOVERY MODE is active.
- Execute the complete business scenario against the real page.
- Collect runtime evidence, screenshots, URLs, tool results and observable UI states.
- Do not generate, write, save or request a spec file.
- Do not call save_spec_file.
- When the requested exploration is complete, return a concise final summary with no function call.`
  : `- Save generated specs using save_spec_file only after runtime evidence exists.`}
- Generated web specs must be CommonJS JavaScript.
- Generated web specs must be executable CommonJS JavaScript.

For Help Centre / FAQ / visual / exploratory specs, generate code that imports only real existing helpers:
  const { test, expect } = require('@playwright/test');
  const { loadProjectEnv, readEnv } = require('../../src/env');
  const { VisualValidator } = require('../../src/visualValidator');
  const { runAdvancedHelpCenterExploration } = require('../../src/helpCenterAdvancedExplorer');

Do not invent APIs.
Do not generate comments instead of executable code.
Do not use expect(page).toHaveVisualRegression().
Do not call olive.auditLinksButtons().
Do not call olive.exploreHelpCenter().
Do not import LLMJudge.
Do not use TypeScript annotations.

The generated Help Centre spec must:
- resolve URL from env using TARGET_ENV, URL_PROD, URL_UAT, HELP_CENTER_WEB_URL
- navigate to the Help Centre URL
- capture landing screenshot
- call VisualValidator.captureAndCompare('web_help_centre_faq_landing')
- attach baseline and actual images
- attach diff and overlay images only when visualResult.hasDifference is true
- assert visualResult.passed is true
- call runAdvancedHelpCenterExploration(page, ...)
- attach exploration JSON and screenshots
- assert key exploration counts are greater than zero
- save audit/exploration JSON under reports/audits
- run without LLM on future executions
- Do not hardcode usernames, access keys, API keys, service-account paths, passwords, or personal data in generated specs.
- BrowserStack credentials must be read from BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY.
- Gemini settings must be read from GEMINI_API_KEY or Vertex AI environment variables.
`;

  const chat = ai.chats.create({
    model,
    config: {
      systemInstruction,
      tools: filterSpecGenerationTool([{ functionDeclarations: geminiTools }]),
      temperature: 0.1,
    },
  });

  let response;
  let testFailed = false;
  let consecutiveErrors = 0;
  let executionTurnCount = 0;
  const maxTurns = Number(readEnv('AGENT_MAX_TURNS', '30'));

  try {
    response = await chat.sendMessage({ message: scenarioText });
    recordUsage(metrics, response, 'Initial planning');

    if (!response.functionCalls || response.functionCalls.length === 0) {
      response = await chat.sendMessage({
        message: isWeb
          ? `Start execution now. First call pw_navigate with URL ${targetUrl}, then open Olive.`
          : 'Start execution now. First call mobile_start_session.',
      });
      recordUsage(metrics, response, 'Forced execution start');
    }

    while (response.functionCalls && response.functionCalls.length > 0) {
      if (executionTurnCount >= maxTurns) {
        if (!isDiscoveryMode) {
          testFailed = true;
        }

        console.error(
          `⚠️ Reached AGENT_MAX_TURNS=${maxTurns}. ` +
          `Stopping further tool execution.`
        );
        break;
      }

      const functionCall = response.functionCalls[0];
      executionTurnCount += 1;

      const stepStart = Date.now();
      const stepRecord = {
        turn: executionTurnCount,
        name: functionCall.name,
        status: 'RUNNING',
        durationMs: 0,
        tokenCount: response.usageMetadata ? response.usageMetadata.totalTokenCount : undefined,
        argsPreview: preview(functionCall.args || {}),
        outputPreview: '',
      };

      console.log(`\n[Turn ${executionTurnCount}] 🤖 AI -> ${functionCall.name}`);
      if (functionCall.args) console.log(`👉 Args: ${JSON.stringify(functionCall.args)}`);

      let toolOutput = '';
      let isError = false;

      if (functionCall.name === 'verify_generative_response') {
        const judgement = await judgeChatbotResponse({
          userMessage: functionCall.args.userMessage,
          botResponse: functionCall.args.botResponse,
          expectedIntent: functionCall.args.expectedIntent,
          acceptanceCriteria: functionCall.args.acceptanceCriteria || [],
          blockedPatterns: functionCall.args.blockedPatterns || [],
          currentState: functionCall.args.currentState || 'START',
          allowedNextStates: functionCall.args.allowedNextStates || [],
          flowId: functionCall.args.flowId || '',
          flowContext: functionCall.args.flowContext || null,
        });

        isError = !judgement.passed;
        toolOutput = JSON.stringify(judgement, null, 2);

        const validationRecord = {
          turn: executionTurnCount,
          userMessage: functionCall.args.userMessage,
          botResponse: functionCall.args.botResponse,
          expectedIntent: functionCall.args.expectedIntent,
          acceptanceCriteria: functionCall.args.acceptanceCriteria || [],
          blockedPatterns: functionCall.args.blockedPatterns || [],
          currentState: functionCall.args.currentState || 'START',
          allowedNextStates: functionCall.args.allowedNextStates || [],
          flowId: functionCall.args.flowId || '',
          detectedState: judgement.detectedState,
          transitionValid: judgement.transitionValid,
          judgeMode: judgement.judgeMode,
          passed: Boolean(judgement.passed),
          score: Number(judgement.score || 0),
          intentMatched: judgement.intentMatched,
          safe: judgement.safe,
          hallucinationRisk: judgement.hallucinationRisk,
          missing: judgement.missing || [],
          issues: judgement.issues || [],
          evidence: judgement.evidence || [],
          summary: judgement.summary || '',
        };

        metrics.validations.push(validationRecord);
        metrics.transcript.push({
          turn: executionTurnCount,
          type: 'llm_judge',
          userMessage: validationRecord.userMessage,
          botResponse: validationRecord.botResponse,
          judgement: validationRecord,
        });

        console.log(`⚖️  Judge score: ${judgement.score} | passed=${judgement.passed} | ${judgement.summary}`);

        if (isError) testFailed = true;
      } else if (
        functionCall.name === 'save_spec_file' &&
        isDiscoveryMode
      ) {
        toolOutput =
          'Discovery mode is active. Spec generation is intentionally skipped.';

        console.log(`🚫 ${toolOutput}`);
      } else if (functionCall.name === 'save_spec_file') {
        const requestedName = functionCall.args.filename || `${baseName}.spec.js`;
        const safeName = path.basename(requestedName).endsWith('.spec.js')
          ? path.basename(requestedName)
          : `${baseName}.spec.js`;

        const targetSpecPath = path.join(specsDir, safeName);
        fs.writeFileSync(targetSpecPath, cleanGeneratedCode(functionCall.args.codeContent), 'utf-8');

        metrics.savedSpecPath = targetSpecPath;
        toolOutput = `Spec file written to ${targetSpecPath}`;
        console.log(`💾 ${toolOutput}`);
      } else {
        const mcpToolTimeoutMs = Number(
          process.env.MCP_TOOL_TIMEOUT_MS || 60000
        );

        console.log(
          `⏱️ MCP timeout for ${functionCall.name}: ` +
          `${mcpToolTimeoutMs}ms`
        );

        const mcpResult = await mcpClient.callTool(
          {
            name: functionCall.name,
            arguments: functionCall.args || {},
          },
          undefined,
          {
            timeout: mcpToolTimeoutMs,
          }
        );

        toolOutput = getToolText(mcpResult);
        isError = Boolean(mcpResult.isError);

        console.log(toolOutput.slice(0, 2500));

        attachScreenshots(metrics, toolOutput);

        if (functionCall.name === 'pw_compare_visual') {
          const visualResult = parseToolJson(toolOutput);
          if (visualResult) {
            metrics.visualComparisons.push(visualResult);
          }
        }

        if (functionCall.name === 'pw_send_olive_message') {
          const parsed = parseToolJson(toolOutput);
          if (parsed) {
            metrics.transcript.push({
              turn: executionTurnCount,
              type: 'olive_message',
              userMessage: parsed.userMessage,
              botResponse: parsed.botResponse,
              botResponseLength: parsed.botResponse ? parsed.botResponse.length : 0,
              fullConversationLength: parsed.fullConversation ? parsed.fullConversation.length : 0,
            });
          }
        }

        if (isError) {
          testFailed = true;
        }
      }

      stepRecord.status = isError ? 'FAILED' : 'SUCCESS';
      stepRecord.durationMs = Date.now() - stepStart;
      stepRecord.outputPreview = preview(toolOutput);
      metrics.steps.push(stepRecord);

      consecutiveErrors = isError ? consecutiveErrors + 1 : 0;

      if (consecutiveErrors >= 3) {
        testFailed = true;
        toolOutput += '\nStopped after 3 consecutive tool failures.';
        console.error('❌ Stopped after 3 consecutive tool failures.');
        break;
      }

      const maxToolOutputChars = Number(
        readEnv('MAX_TOOL_OUTPUT_CHARS', '3500')
      );

      if (
        typeof toolOutput === 'string' &&
        toolOutput.length > maxToolOutputChars
      ) {
        toolOutput =
          toolOutput.slice(
            0,
            maxToolOutputChars
          ) +
          '\n[Tool output truncated by framework]';
      }

      response = await chat.sendMessage({
        message: [
          {
            functionResponse: {
              name: functionCall.name,
              response: {
                result: toolOutput,
                failed: isError,
              },
            },
          },
        ],
      });

      recordUsage(metrics, response, `After ${functionCall.name}`);
    }
  } finally {
    if (
      !isDiscoveryMode &&
      metrics.savedSpecPath &&
      readEnv('AUTO_RUN_GENERATED_SPEC', 'false').toLowerCase() === 'true'
    ) {
      console.log(`\n▶️  AUTO_RUN_GENERATED_SPEC=true, executing generated spec: ${metrics.savedSpecPath}`);

      const playwrightArgs = ['playwright', 'test', metrics.savedSpecPath, '--project=chromium'];

      if (process.env.HEADLESS === 'false') {
        playwrightArgs.push('--headed');
      }

      const specStart = Date.now();
      const result = spawnSync('npx', playwrightArgs, {
        cwd: __dirname,
        stdio: 'inherit',
        env: process.env,
      });

      metrics.steps.push({
        turn: metrics.steps.length + 1,
        name: 'execute_generated_playwright_spec',
        status: result.status === 0 ? 'SUCCESS' : 'FAILED',
        durationMs: Date.now() - specStart,
        argsPreview: playwrightArgs.join(' '),
        outputPreview: `Exit status: ${result.status}`,
      });

      if (result.status !== 0) {
        testFailed = true;
      }
    }

    metrics.endedAt = new Date().toISOString();
    metrics.durationMs = Date.now() - runStartMs;

    const transcriptPath = path.join(transcriptDir, `${baseName}.transcript.json`);
    const metricsJsonPath = path.join(reportsDir, `${baseName}.metrics.json`);

    metrics.transcriptJsonPath = transcriptPath;
    metrics.metricsJsonPath = metricsJsonPath;

    writeJson(transcriptPath, metrics.transcript);
    writeJson(metricsJsonPath, metrics);

    try {
      const compiledHtml = generateHtmlReport({
        scenarioName: baseName,
        metrics,
      });

      fs.writeFileSync(path.join(reportsDir, `${baseName}.report.html`), compiledHtml, 'utf-8');

      console.log(`📊 HTML report saved: reports/${baseName}.report.html`);
      console.log(`📄 Metrics JSON saved: reports/${baseName}.metrics.json`);
      console.log(`🧾 Transcript JSON saved: reports/transcripts/${baseName}.transcript.json`);
    } catch (reportError) {
      console.error(`⚠️ Failed to generate report: ${reportError.message}`);
    }

    const successfulDiscoverySteps = metrics.steps.filter((step) => {
      const status = String(step.status || '').toUpperCase();

      return [
        'SUCCESS',
        'PASSED',
        'COMPLETED',
      ].includes(status);
    }).length;

    const minimumSuccessfulSteps = Number(
      readEnv('MIN_DISCOVERY_SUCCESSFUL_STEPS', '3')
    );

    const minimumScreenshots = Number(
      readEnv('MIN_DISCOVERY_SCREENSHOTS', '1')
    );

    /*
     * Discovery success represents framework execution and evidence
     * collection. It must not depend on whether Olive passed the
     * semantic LLM judge.
     *
     * Generative scenarios may produce transcript, metrics and judge
     * evidence without requiring screenshots. Deterministic and visual
     * scenarios continue to require the configured screenshot minimum.
     */
    const isGenerativeScenario =
      /^TEST_TYPE:\s*Generative/im.test(targetScenario) ||
      /^TYPE:\s*Generative/im.test(targetScenario) ||
      /@generative\b/i.test(targetScenario);

    const hasTranscriptEvidence =
      Array.isArray(metrics.conversationTurns) &&
      metrics.conversationTurns.length > 0;

    const hasJudgeEvidence =
      Array.isArray(metrics.judgements) &&
      metrics.judgements.length > 0;

    const hasGenerativeEvidence =
      hasTranscriptEvidence ||
      hasJudgeEvidence ||
      metrics.steps.some((step) =>
        [
          'pw_send_olive_message',
          'verify_generative_response',
        ].includes(String(step.tool || step.name || ''))
      );

    const hasRequiredEvidence = isGenerativeScenario
      ? hasGenerativeEvidence
      : metrics.screenshots.length >= minimumScreenshots;

    const discoverySucceeded =
      successfulDiscoverySteps >= minimumSuccessfulSteps &&
      hasRequiredEvidence;

    /*
     * In discovery mode, application assertion failures are evidence,
     * not framework failures. Outside discovery mode, normal test
     * pass/fail behaviour remains unchanged.
     */
    const finalFailed = isDiscoveryMode
      ? !discoverySucceeded
      : testFailed;

    if (isDiscoveryMode) {
      console.log('');
      console.log('🔎 Discovery completion summary');
      console.log(
        `• Successful runtime steps: ${successfulDiscoverySteps}`
      );
      console.log(
        `• Captured screenshots: ${metrics.screenshots.length}`
      );
      console.log(
        `• Generated spec: ${metrics.savedSpecPath ? 'unexpected' : 'none'}`
      );
      console.log(
        `• Framework discovery: ${
          discoverySucceeded ? 'PASSED' : 'FAILED'
        }`
      );
      console.log(
        `• Application assertions: ${
          testFailed ? 'FAILED' : 'PASSED'
        }`
      );

      if (testFailed && discoverySucceeded) {
        console.log(
          '⚠️ Application or LLM-judge assertions failed, but the ' +
          'framework completed discovery and collected sufficient evidence.'
        );
      }
    }

    try {
      if (
        mcpClient &&
        typeof mcpClient.close === 'function'
      ) {
        await mcpClient.close();
        console.log('🧹 MCP client closed.');
      }
    } catch (closeError) {
      console.warn(
        `⚠️ Failed to close MCP client cleanly: ${closeError.message}`
      );
    }

    console.log(
      finalFailed
        ? '❌ Agent process concluded with failures.'
        : isDiscoveryMode
          ? '✅ Discovery completed successfully.'
          : '✅ Agent process concluded.'
    );

    process.exit(finalFailed ? 1 : 0);
  }
}

const explicitTargetInstruction = `
${targetScenario}

EXECUTION CONTEXT:
- Platform: ${isWeb ? 'Web' : 'Mobile'}
- Target infrastructure: ${executionTarget.toUpperCase()}
${isWeb ? `- Target URL: ${targetUrl}\n- Use this exact Target URL even if the scenario text contains another URL.` : ''}
${isBrowserStack ? `
- BrowserStack mode is enabled. Generated code must read credentials from BROWSERSTACK_USERNAME and BROWSERSTACK_ACCESS_KEY only.
- Mobile app hash must be read from BROWSERSTACK_APP_HASH, APP_UAT, or APP_PROD.
` : `
- Local mode is enabled. Use local browser/Appium settings unless the scenario explicitly states BrowserStack.
`}
`;

executeGenerativeFlow(explicitTargetInstruction).catch(error => {
  console.error(`❌ Agent fatal error: ${error.stack || error.message}`);
  process.exit(1);
});
