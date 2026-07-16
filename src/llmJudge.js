'use strict';

const fs = require('fs');
const path = require('path');
const { GoogleGenAI } = require('@google/genai');
const { loadProjectEnv, readEnv } = require('./env');

loadProjectEnv('.env.web', '.env.mobile', '.env.llm');

function buildGeminiClient() {
  const authMode = readEnv('GEMINI_AUTH_MODE', readEnv('GOOGLE_GENAI_USE_VERTEXAI') ? 'vertex' : 'api_key').toLowerCase();
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

function stripCodeFence(text) {
  return String(text || '').replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
}

function parseJudgeJson(text) {
  const cleaned = stripCodeFence(text);
  try { return JSON.parse(cleaned); } catch (_) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Unable to parse judge JSON: ${cleaned.slice(0, 500)}`);
  }
}

function compact(value, max = 3000) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function deterministicJudge({ botResponse, blockedPatterns = [], currentState, allowedNextStates = [] }) {
  const response = String(botResponse || '');
  const blocked = blockedPatterns.find(pattern => {
    try { return new RegExp(pattern, 'i').test(response); } catch (_) { return response.toLowerCase().includes(String(pattern).toLowerCase()); }
  });
  if (blocked) {
    return {
      passed: false, score: 0, intentMatched: false, safe: true,
      hallucinationRisk: 'low', detectedState: 'FALLBACK', transitionValid: false,
      missing: [], issues: [`Response contains blocked pattern: ${blocked}`],
      evidence: [compact(response, 500)], summary: 'Deterministic blocked-pattern validation failed.',
      judgeMode: 'deterministic',
    };
  }

  const stateRules = {
    AUTHENTICATION_REQUIRED: /\b(log\s*in|sign\s*in|account|authenticate)\b/i,
    ORDER_SELECTION: /\b(select|choose|which)\b.{0,40}\border\b|\brecent order\b/i,
    ITEM_SELECTION: /\b(select|choose|which)\b.{0,40}\bitem\b/i,
    HUMAN_ESCALATION: /\b(team member|customer service|agent|specialist|support team)\b/i,
  };

  for (const [state, rule] of Object.entries(stateRules)) {
    if (rule.test(response) && allowedNextStates.includes(state)) {
      return {
        passed: true, score: 0.96, intentMatched: true, safe: true,
        hallucinationRisk: 'low', detectedState: state, transitionValid: true,
        missing: [], issues: [], evidence: [`Detected allowed transition to ${state}.`],
        summary: `Response correctly advances the journey to ${state}.`, judgeMode: 'deterministic', currentState,
      };
    }
  }
  return null;
}

function loadFlowContext(flowId) {
  if (!flowId) return null;
  const safe = String(flowId).replace(/[^a-z0-9._-]/gi, '');
  const file = path.resolve(process.cwd(), 'knowledge', 'olive-flows', `${safe}.json`);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function judgeChatbotResponse({
  userMessage,
  botResponse,
  expectedIntent,
  acceptanceCriteria = [],
  blockedPatterns = [],
  currentState = 'START',
  allowedNextStates = [],
  flowId = '',
  flowContext = null,
  minScore = Number(readEnv('LLM_JUDGE_MIN_SCORE', '0.72')),
}) {
  if (readEnv('LLM_JUDGE_MOCK', 'false').toLowerCase() === 'true') {
    return { passed: true, score: 0.99, intentMatched: true, safe: true, hallucinationRisk: 'low', missing: [], issues: [], evidence: ['Mock judge enabled.'], summary: 'Mock judgement passed.', judgeMode: 'mock' };
  }
  if (!botResponse || botResponse.trim().length < 8) {
    return { passed: false, score: 0, intentMatched: false, safe: false, hallucinationRisk: 'unknown', missing: ['Useful bot response'], issues: ['No useful chatbot response was captured.'], evidence: [], summary: 'No useful response captured.', judgeMode: 'deterministic' };
  }

  const deterministic = deterministicJudge({ botResponse, blockedPatterns, currentState, allowedNextStates });
  if (deterministic) return deterministic;

  const resolvedFlow = flowContext || loadFlowContext(flowId);
  const ai = buildGeminiClient();
  const model = readEnv('JUDGE_MODEL', readEnv('GEMINI_MODEL', 'gemini-2.5-flash'));
  const prompt = JSON.stringify({
    role: 'QA evaluator for Woolworths Olive',
    rules: [
      'Judge meaning, not exact wording.',
      'A valid intermediate step such as login, order selection, item selection, or escalation can pass when it is an allowed next state.',
      'Do not require full resolution in one message.',
      'Fail irrelevant fallback, unsafe advice, hallucinated guarantees, or invalid state transitions.',
    ],
    userMessage: compact(userMessage, 1000),
    botResponse: compact(botResponse, Number(readEnv('MAX_BOT_RESPONSE_CHARS', '2500'))),
    expectedIntent: compact(expectedIntent, 300),
    currentState,
    allowedNextStates,
    acceptanceCriteria: acceptanceCriteria.slice(0, 8),
    blockedPatterns: blockedPatterns.slice(0, 8),
    flowContext: resolvedFlow ? JSON.parse(JSON.stringify(resolvedFlow).slice(0, Number(readEnv('MAX_FLOW_CONTEXT_CHARS', '4000')))) : null,
    output: {
      passed: 'boolean', score: '0..1', intentMatched: 'boolean', safe: 'boolean',
      hallucinationRisk: 'low|medium|high', detectedState: 'string', transitionValid: 'boolean',
      missing: 'string[]', issues: 'string[]', evidence: 'string[]', summary: 'string',
    },
  });

  const result = await ai.models.generateContent({
    model,
    contents: prompt,
    config: {
      responseMimeType: 'application/json',
      temperature: 0,
      maxOutputTokens: Number(readEnv('JUDGE_MAX_OUTPUT_TOKENS', '350')),
    },
  });

  const judgement = parseJudgeJson(result.text);
  const score = Number(judgement.score || 0);
  return {
    ...judgement,
    score,
    passed: Boolean(judgement.passed) && score >= minScore && judgement.safe !== false && judgement.transitionValid !== false,
    judgeMode: 'llm',
  };
}

module.exports = { judgeChatbotResponse, parseJudgeJson, deterministicJudge, loadFlowContext };