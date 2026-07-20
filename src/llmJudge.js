'use strict';

const { GoogleGenAI } = require('@google/genai');
const { loadProjectEnv, readEnv } = require('./env');

loadProjectEnv('.env.web', '.env.mobile', '.env.llm');

function buildGeminiClient() {
  const authMode = readEnv('GEMINI_AUTH_MODE', 'api_key').toLowerCase();
  if (authMode === 'vertex') {
    const project = readEnv('GOOGLE_CLOUD_PROJECT') || readEnv('GCP_PROJECT_ID');
    const location = readEnv('GOOGLE_CLOUD_LOCATION') || readEnv('GCP_LOCATION', 'us-central1');
    if (!project) throw new Error('Vertex mode requires GOOGLE_CLOUD_PROJECT or GCP_PROJECT_ID.');
    if (!readEnv('GOOGLE_APPLICATION_CREDENTIALS')) throw new Error('Vertex mode requires GOOGLE_APPLICATION_CREDENTIALS.');
    return new GoogleGenAI({ vertexai: true, project, location });
  }
  const apiKey = readEnv('GEMINI_API_KEY');
  if (!apiKey) throw new Error('Set GEMINI_API_KEY or configure Vertex AI authentication.');
  return new GoogleGenAI({ apiKey });
}

function compact(value, max = 4000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function extractJson(text) {
  const raw = String(text || '').trim();
  const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(cleaned); } catch (_) {}
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
  throw new Error(`LLM returned invalid JSON: ${compact(raw, 500)}`);
}

function numberEnv(name, fallback) {
  const value = Number(readEnv(name, String(fallback)));
  return Number.isFinite(value) ? value : fallback;
}

function scenarioSummary(text) {
  const source = String(text || '');
  const maxChars = numberEnv('RUNTIME_SCENARIO_SUMMARY_CHARS', 3200);
  const importantHeaders = new Set([
    'TITLE', 'PLATFORM', 'EXECUTION_MODE', 'TARGET_PATH', 'GOAL', 'RULES',
    'EXECUTION_FLOW', 'PASS_CONDITIONS', 'FAILURE_CONDITIONS', 'MAX_CUSTOMER_TURNS',
  ]);
  const lines = source.split(/\r?\n/);
  const selected = [];
  let active = false;
  for (const line of lines) {
    const match = line.match(/^([A-Z][A-Z0-9_ ]+):\s*(.*)$/);
    if (match) {
      active = importantHeaders.has(match[1].trim());
      if (active) selected.push(line.trim());
      continue;
    }
    if (active && line.trim()) selected.push(line.trim());
  }
  return compact(selected.join('\n') || source, maxChars);
}

function normaliseText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function scenarioKeywords(scenario) {
  const stop = new Set(['the','and','for','with','from','that','this','then','when','into','using','use','only','must','should','scenario','flow','step','visible','runtime','application','chat','page','control','input']);
  return [...new Set(String(scenario || '').toLowerCase().match(/[a-z][a-z0-9'-]{3,}/g) || [])]
    .filter(word => !stop.has(word))
    .slice(0, 40);
}

function shellControl(label) {
  return /^(?:minimise(?: the chat)?|close(?: the chat)?|privacy policy|collection notice|send|start voice input\b)/i.test(normaliseText(label));
}

function compactSurface(surface = {}, previousSurface = {}, keywords = []) {
  const maxMessages = numberEnv('RUNTIME_MAX_NEW_MESSAGES', 5);
  const maxControls = numberEnv('RUNTIME_MAX_RELEVANT_CONTROLS', 12);
  const maxText = numberEnv('RUNTIME_MAX_RELEVANT_TEXT_BLOCKS', 8);
  const previousMessages = new Set((previousSurface.messages || []).map(item => normaliseText(item?.text || item)));
  const previousControls = new Set((previousSurface.controls || []).map(item => `${item?.id || ''}|${normaliseText(item?.label)}`));

  const messages = (surface.messages || [])
    .map(item => ({ id: item?.id || '', text: normaliseText(item?.text || item) }))
    .filter(item => item.text && !/^sent\s+\d/i.test(item.text));
  const newMessages = messages.filter(item => !previousMessages.has(item.text));

  const controls = (surface.controls || [])
    .filter(item => item?.enabled !== false)
    .map(item => ({ id: item?.id || '', type: item?.type || 'control', label: normaliseText(item?.label), enabled: true }))
    .filter(item => item.id && item.label && !shellControl(item.label));

  const scoredControls = controls.map((item, index) => {
    const lower = item.label.toLowerCase();
    const isNew = !previousControls.has(`${item.id}|${item.label}`);
    const overlap = keywords.reduce((score, keyword) => score + (lower.includes(keyword) ? 1 : 0), 0);
    return { item, score: (isNew ? 100 : 0) + overlap * 10 - index * 0.001 };
  }).sort((a, b) => b.score - a.score).slice(0, maxControls).map(entry => entry.item);

  const inputs = (surface.inputs || [])
    .filter(item => item?.enabled !== false)
    .slice(0, 4)
    .map(item => ({ id: item?.id || '', type: item?.type || 'text', placeholder: normaliseText(item?.placeholder), enabled: true }));

  const text = (surface.text || [])
    .map(normaliseText)
    .filter(Boolean)
    .filter(value => keywords.some(keyword => value.toLowerCase().includes(keyword)))
    .slice(0, maxText);

  return {
    ready: Boolean(surface.surfaceReady ?? surface.ready),
    busy: Boolean(surface.busy),
    url: normaliseText(surface.url),
    title: normaliseText(surface.title),
    newMessages: newMessages.slice(-maxMessages),
    recentMessages: messages.slice(-maxMessages),
    controls: scoredControls,
    inputs,
    relevantText: text,
    counts: {
      messages: messages.length,
      controls: controls.length,
      inputs: inputs.length,
    },
  };
}

function compactRuntimeState(state = {}, previousState = {}, scenario = '') {
  const keywords = scenarioKeywords(scenario);
  return {
    chat: compactSurface(state.chat || state, previousState.chat || previousState, keywords),
    page: compactSurface(state.page || {}, previousState.page || {}, keywords),
  };
}

function stateDelta(previousState = {}, currentState = {}, scenario = '') {
  const previous = compactRuntimeState(previousState, {}, scenario);
  const current = compactRuntimeState(currentState, previousState, scenario);
  const deltaFor = (before, after) => ({
    urlChanged: before.url !== after.url ? { before: before.url, after: after.url } : null,
    titleChanged: before.title !== after.title ? { before: before.title, after: after.title } : null,
    newMessages: after.newMessages,
    addedControls: after.controls.filter(item => !before.controls.some(old => old.id === item.id && old.label === item.label)),
    removedControls: before.controls.filter(item => !after.controls.some(now => now.id === item.id && now.label === item.label)),
    counts: { before: before.counts, after: after.counts },
  });
  return { chat: deltaFor(previous.chat, current.chat), page: deltaFor(previous.page, current.page) };
}

async function requestJson({ ai, model, prompt, schema, maxOutputTokens, temperature }) {
  const startedAt = Date.now();
  const result = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      responseJsonSchema: schema,
      temperature,
      maxOutputTokens,
      thinkingConfig: { thinkingBudget: numberEnv('RUNTIME_THINKING_BUDGET', 0) },
    },
  });
  const raw = String(result.text || result.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || '').trim();
  const usage = result.usageMetadata || result.response?.usageMetadata || {};
  return {
    raw,
    metadata: {
      provider: 'gemini',
      model,
      temperature,
      maxOutputTokens,
      promptTokenCount: Number(usage.promptTokenCount || 0),
      candidatesTokenCount: Number(usage.candidatesTokenCount || 0),
      cachedContentTokenCount: Number(usage.cachedContentTokenCount || 0),
      totalTokenCount: Number(usage.totalTokenCount || 0),
      finishReason: result.candidates?.[0]?.finishReason || 'UNKNOWN',
      durationMs: Date.now() - startedAt,
      requestPayload: prompt,
      responsePayload: raw,
    },
  };
}

async function generateJson(prompt, schema, label) {
  const ai = buildGeminiClient();
  const model = readEnv('GEMINI_MODEL', 'gemini-2.5-flash');
  const attempts = Math.max(1, numberEnv('RUNTIME_JSON_ATTEMPTS', 2));
  const maxOutputTokens = numberEnv('RUNTIME_MAX_OUTPUT_TOKENS', 1200);
  const temperature = numberEnv('RUNTIME_LLM_TEMPERATURE', 0);
  let lastError;
  let lastRaw = '';
  let lastMetadata = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const requestPrompt = attempt === 1 ? prompt : JSON.stringify({
        role: 'JSON response repairer',
        instruction: 'Return one complete JSON object matching the supplied schema. Do not include markdown or commentary.',
        schema,
        invalidPreviousResponse: compact(lastRaw, 1600),
        originalRequest: compact(prompt, 5000),
      });
      const response = await requestJson({ ai, model, prompt: requestPrompt, schema, maxOutputTokens, temperature });
      lastRaw = response.raw;
      lastMetadata = { ...response.metadata, stage: label, attempt };
      const parsed = extractJson(lastRaw);
      return { ...parsed, _llm: lastMetadata };
    } catch (error) {
      lastError = error;
      console.error(`[${label}] attempt ${attempt}/${attempts} failed: ${compact(lastRaw || error.message, 300)}`);
    }
  }
  const error = new Error(`${label} failed after ${attempts} attempts: ${lastError?.message || 'invalid response'}`);
  error.rawResponse = lastRaw;
  error.llmMetadata = lastMetadata;
  throw error;
}

const actionSchema = {
  type: 'object',
  properties: {
    scope: { type: 'string', enum: ['CHAT', 'PAGE'] },
    action: { type: 'string', enum: ['CLICK', 'TYPE', 'SEND_MESSAGE', 'WAIT', 'COMPLETE', 'FAIL'] },
    targetId: { type: 'string' }, value: { type: 'string' }, waitMs: { type: 'number' },
    reason: { type: 'string' }, expectedProgress: { type: 'string' }, conversationSummary: { type: 'string' },
    goalStatus: { type: 'string', enum: ['IN_PROGRESS', 'COMPLETE', 'BLOCKED', 'FAILED'] },
  },
  required: ['scope', 'action', 'targetId', 'value', 'waitMs', 'reason', 'expectedProgress', 'conversationSummary', 'goalStatus'],
  additionalProperties: false,
};

async function decideNextAction({ scenario, state, history = [], memory = {} }) {
  const compactState = compactRuntimeState(state, memory.lastState || {}, scenario);
  const prompt = JSON.stringify({
    role: 'Adaptive application and conversational QA agent',
    objective: 'Choose one next action that advances the business goal using visible runtime evidence.',
    rules: [
      'Use runtime target IDs exactly as supplied and never invent IDs.',
      'Use SEND_MESSAGE for chat submission, TYPE for non-submitted input, CLICK for enabled controls, and WAIT only while rendering.',
      'Use PAGE evidence to verify application outcomes; do not trust chatbot confirmation alone.',
      'Do not declare an application outcome solely from a summary label when an available control can open the underlying result.',
      'Use COMPLETE only with visible proof, FAIL only with explicit proof, and BLOCKED only when required capability or information is unavailable.',
      'Visible chips and buttons are actions, not bot messages.',
      'Choose one action only.',
    ],
    scenario: scenarioSummary(scenario),
    memory: {
      summary: compact(memory.conversationSummary, 900),
      goalStatus: memory.goalStatus || 'IN_PROGRESS',
      completedProgress: (memory.completedProgress || []).slice(-8),
      unresolvedRequests: (memory.unresolvedRequests || []).slice(-6),
      noProgressTurns: Number(memory.noProgressTurns || 0),
    },
    currentState: compactState,
    recentHistory: history.slice(-numberEnv('RUNTIME_HISTORY_TURNS', 4)).map(item => ({
      turn: item.turn,
      action: item.action ? { scope: item.action.scope, action: item.action.action, targetId: item.action.targetId, value: compact(item.action.value, 160), reason: compact(item.action.reason, 240) } : null,
      result: item.judgement ? { goalStatus: item.judgement.goalStatus, madeProgress: item.judgement.madeProgress, reason: compact(item.judgement.reason, 240) } : null,
    })),
    output: actionSchema,
  });
  const action = await generateJson(prompt, actionSchema, 'Runtime planner');
  const kind = String(action.action || '').toUpperCase();
  const value = String(action.value || '').trim();
  const targetId = String(action.targetId || '').trim();

  if ((kind === 'SEND_MESSAGE' || kind === 'TYPE') && !value) {
    const repairPrompt = JSON.stringify({
      role: 'Runtime action repairer',
      instruction: 'Return one complete action JSON object. SEND_MESSAGE and TYPE require a non-empty value. CLICK requires a supplied runtime targetId. Preserve the original intent and do not invent a target ID.',
      originalAction: action,
      scenario: scenarioSummary(scenario),
      currentState: compactState,
      output: actionSchema,
    });
    const repaired = await generateJson(repairPrompt, actionSchema, 'Runtime planner repair');
    const repairedKind = String(repaired.action || '').toUpperCase();
    if ((repairedKind === 'SEND_MESSAGE' || repairedKind === 'TYPE') && !String(repaired.value || '').trim()) {
      throw new Error(`Runtime planner returned ${repairedKind} without a message value.`);
    }
    if (repairedKind === 'CLICK' && !String(repaired.targetId || '').trim()) {
      throw new Error('Runtime planner returned CLICK without a runtime targetId.');
    }
    return repaired;
  }

  if (kind === 'CLICK' && !targetId) {
    throw new Error('Runtime planner returned CLICK without a runtime targetId.');
  }
  return action;
}

const outcomeSchema = {
  type: 'object',
  properties: {
    goalStatus: { type: 'string', enum: ['IN_PROGRESS', 'COMPLETE', 'BLOCKED', 'FAILED'] },
    madeProgress: { type: 'boolean' }, shouldContinue: { type: 'boolean' }, score: { type: 'number' },
    reason: { type: 'string' }, conversationSummary: { type: 'string' },
    completedProgress: { type: 'array', items: { type: 'string' } },
    unresolvedRequests: { type: 'array', items: { type: 'string' } },
    evidence: { type: 'array', items: { type: 'string' } },
  },
  required: ['goalStatus','madeProgress','shouldContinue','score','reason','conversationSummary','completedProgress','unresolvedRequests','evidence'],
  additionalProperties: false,
};

async function judgeStructuredOutcome({ scenario, previousState, action, result, currentState, memory = {} }) {
  const delta = stateDelta(previousState || {}, currentState || {}, scenario);
  const prompt = JSON.stringify({
    role: 'Business-flow evidence evaluator',
    objective: 'Evaluate the latest action from concise before/after evidence and explain the result in plain language.',
    rules: [
      'Judge semantic progress, not exact wording.',
      'A valid follow-up question or new action is progress.',
      'Set COMPLETE only when observable evidence proves the acceptance goal.',
      'Set FAILED only for explicit application errors, contradicted outcomes, impossible flows, or failed execution.',
      'A recovery control is not itself an error message.',
      'Do not infer contents from a summary label when the underlying area was not opened and inspected.',
      'Use evidence strings that a non-technical stakeholder can understand.',
    ],
    scenario: scenarioSummary(scenario),
    memory: {
      summary: compact(memory.conversationSummary, 900),
      completedProgress: (memory.completedProgress || []).slice(-8),
      unresolvedRequests: (memory.unresolvedRequests || []).slice(-6),
    },
    action: {
      scope: action?.scope, action: action?.action, targetId: action?.targetId,
      value: compact(action?.value, 200), expectedProgress: compact(action?.expectedProgress, 300), reason: compact(action?.reason, 300),
    },
    executionResult: { executed: result?.executed !== false, error: compact(result?.error, 300) },
    stateDelta: delta,
    currentEvidence: compactRuntimeState(currentState || {}, previousState || {}, scenario),
    output: outcomeSchema,
  });
  const judgement = await generateJson(prompt, outcomeSchema, 'Semantic judge');
  const score = Number(judgement.score || 0);
  const goalStatus = judgement.goalStatus || 'IN_PROGRESS';
  return { ...judgement, score, goalStatus, passed: goalStatus === 'IN_PROGRESS' || goalStatus === 'COMPLETE', complete: goalStatus === 'COMPLETE' };
}

async function judgeChatbotResponse({ userMessage, botResponse, expectedIntent, acceptanceCriteria = [], blockedPatterns = [] }) {
  const response = String(botResponse || '');
  const blocked = blockedPatterns.find(pattern => {
    try { return new RegExp(pattern, 'i').test(response); } catch (_) { return response.toLowerCase().includes(String(pattern).toLowerCase()); }
  });
  if (blocked) return { passed: false, score: 0, issues: [`Blocked pattern: ${blocked}`], evidence: [compact(response, 500)], summary: 'Blocked response detected.', judgeMode: 'deterministic' };
  const scenario = JSON.stringify({ expectedIntent, acceptanceCriteria, userMessage });
  const result = await judgeStructuredOutcome({ scenario, previousState: {}, action: { action: 'SEND_MESSAGE', value: userMessage }, result: { executed: true }, currentState: { messages: [{ text: compact(response, 2500) }] } });
  return { ...result, userMessage, botResponse: response, expectedIntent, intentMatched: result.passed, safe: result.passed, transitionValid: result.passed, missing: [], issues: result.passed ? [] : [result.reason], summary: result.reason, judgeMode: 'llm_structured' };
}

module.exports = {
  decideNextAction,
  judgeStructuredOutcome,
  judgeChatbotResponse,
  compactRuntimeState,
  stateDelta,
  scenarioSummary,
  parseJudgeJson: extractJson,
  deterministicJudge: () => null,
  loadFlowContext: () => null,
};
