'use strict';

const { decideNextAction, judgeStructuredOutcome } = require('../llmJudge');

function numberOption(options, key, envKey, fallback) {
  const value = Number(options?.[key] ?? process.env[envKey] ?? fallback);
  return Number.isFinite(value) ? value : fallback;
}

function signature(state) {
  const surface = value => ({
    ready: Boolean(value?.surfaceReady ?? value?.ready),
    busy: Boolean(value?.busy),
    messages: (value?.messages || []).slice(-12).map(item => String(item?.text || item || '').replace(/\s+/g, ' ').trim()),
    controls: (value?.controls || []).filter(item => item?.enabled !== false).map(item => ({ id: item.id, label: item.label })),
    inputs: (value?.inputs || []).filter(item => item?.enabled !== false).map(item => ({ id: item.id, placeholder: item.placeholder })),
    url: String(value?.url || ''),
  });
  return JSON.stringify({ chat: surface(state?.chat || state), page: surface(state?.page || {}) });
}

async function settleState({ captureState, previousState, options = {} }) {
  const timeoutMs = numberOption(options, 'settleTimeoutMs', 'RUNTIME_STATE_SETTLE_TIMEOUT_MS', 65000);
  const pollMs = numberOption(options, 'pollIntervalMs', 'RUNTIME_STATE_POLL_INTERVAL_MS', 750);
  const requiredStable = numberOption(options, 'stablePolls', 'RUNTIME_STATE_STABLE_POLLS', 2);
  const minSettleMs = numberOption(options, 'minSettleMs', 'RUNTIME_STATE_MIN_SETTLE_MS', 5000);
  const quietMs = numberOption(options, 'quietPeriodMs', 'RUNTIME_STATE_QUIET_PERIOD_MS', 2500);
  const startedAt = Date.now();
  const before = signature(previousState);
  let latest = await captureState();
  let latestSignature = signature(latest);
  let changed = latestSignature !== before;
  let stablePolls = 0;
  let lastChangeAt = changed ? Date.now() : startedAt;
  let captures = 1;

  while (Date.now() - startedAt < timeoutMs) {
    await new Promise(resolve => setTimeout(resolve, pollMs));
    const next = await captureState();
    const nextSignature = signature(next);
    captures += 1;
    if (nextSignature !== latestSignature) {
      latest = next;
      latestSignature = nextSignature;
      changed = changed || nextSignature !== before;
      stablePolls = 0;
      lastChangeAt = Date.now();
    } else {
      latest = next;
      stablePolls += 1;
    }

    const elapsed = Date.now() - startedAt;
    const quietFor = Date.now() - lastChangeAt;
    if (changed && elapsed >= minSettleMs && quietFor >= quietMs && stablePolls >= requiredStable) break;
  }

  return {
    state: latest,
    evidence: {
      captureCount: captures,
      waitedMs: Date.now() - startedAt,
      meaningfulChangeSeen: changed,
      stablePolls,
      requiredStablePolls: requiredStable,
    },
  };
}


function words(value) {
  return new Set(String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(word => word.length > 2));
}

function controlScore(intent, control, index) {
  const expected = words(intent);
  const actual = words(control?.label);
  let overlap = 0;
  for (const word of expected) if (actual.has(word)) overlap += 1;
  const ordinalBoost = /\bfirst\b/i.test(String(intent || '')) && index === 0 ? 0.25 : 0;
  return expected.size ? overlap / expected.size + ordinalBoost : ordinalBoost;
}

function normaliseMilestone(milestone = {}) {
  if (typeof milestone === 'string') {
    const text = milestone.trim();
    const quotedMessage = text.match(/\bsend\s+['"]([^'"]+)['"]/i);
    if (quotedMessage) return { kind: 'REQUIRED_CUSTOMER_MESSAGE', value: quotedMessage[1], intent: text, sourceText: text };
    if (/^open\b|start a clean conversation/i.test(text)) return { kind: 'PRECONDITION', value: '', intent: text, sourceText: text };
    if (/^wait\b/i.test(text)) return { kind: 'WAIT', value: '', intent: text, sourceText: text };
    if (/\b(?:select|click|choose|tap)\b/i.test(text)) return { kind: 'SEMANTIC_CONTROL', value: '', intent: text, sourceText: text };
    return { kind: 'SEMANTIC_VALIDATION', value: '', intent: text, sourceText: text };
  }

  const action = milestone.action || {};
  const rawType = String(milestone.type || action.type || '').toUpperCase();
  return {
    ...milestone,
    kind: rawType,
    value: milestone.value ?? action.value ?? action.message ?? '',
    intent: milestone.objective || action.semantic_label || milestone.prompt || milestone.name || '',
  };
}

async function runGeneratedJourney({ scenario, adapter, maxTurns = 25, options = {}, onStep }) {
  if (!scenario || !adapter?.captureState || !adapter?.executeAction) {
    throw new Error('Generated journey requires a scenario contract and platform adapter.');
  }
  const milestones = Array.isArray(scenario.milestones) ? scenario.milestones.map(normaliseMilestone) : [];
  if (!milestones.length) throw new Error('Generated journey contract has no milestones.');
  const history = [];
  const memory = { conversationSummary: '', completedProgress: [], unresolvedRequests: [] };
  let state = await adapter.captureState();

  for (let index = 0; index < milestones.length && history.length < maxTurns; index += 1) {
    const milestone = milestones[index];
    if (/PRECONDITION/.test(milestone.kind)) {
      history.push({ step: index + 1, milestone, skipped: true, reason: 'Precondition already completed by the generated spec.' });
      continue;
    }

    let action;
    if (/WAIT/.test(milestone.kind)) {
      const settled = await settleState({ captureState: adapter.captureState, previousState: state, options });
      state = settled.state;
      history.push({ step: index + 1, milestone, action: { action: 'WAIT' }, settleEvidence: settled.evidence, state });
      continue;
    }

    if (/SEND_MESSAGE|REQUIRED_CUSTOMER_MESSAGE/.test(milestone.kind)) {
      if (!String(milestone.value).trim()) throw new Error(`Milestone ${index + 1} requires a customer message.`);
      action = { action: 'SEND_MESSAGE', scope: 'CHAT', targetId: '', value: String(milestone.value), waitMs: 0, reason: milestone.intent };
    } else if (/CLICK_CONTROL|SEMANTIC_CONTROL/.test(milestone.kind)) {
      const controls = (state?.chat?.controls || state?.controls || []).filter(item => item?.enabled !== false);
      const ranked = controls.map((control, controlIndex) => ({ control, score: controlScore(milestone.intent, control, controlIndex) })).sort((a, b) => b.score - a.score);
      if (ranked[0] && ranked[0].score >= numberOption(options, 'localMatchThreshold', 'GENERATED_STEP_LOCAL_MATCH_THRESHOLD', 0.45)) {
        action = { action: 'CLICK', scope: 'CHAT', targetId: ranked[0].control.id, value: '', waitMs: 0, reason: `Local self-healing matched: ${milestone.intent}` };
      } else {
        action = await decideNextAction({ scenario: { businessObjective: scenario.businessObjective, activeMilestone: milestone, successConditions: scenario.successConditions, failureConditions: scenario.failureConditions }, state, history: history.slice(-3), memory });
        delete action._llm;
      }
    } else {
      action = await decideNextAction({ scenario: { businessObjective: scenario.businessObjective, activeMilestone: milestone, successConditions: scenario.successConditions, failureConditions: scenario.failureConditions }, state, history: history.slice(-3), memory });
      delete action._llm;
    }

    if (action.action === 'COMPLETE') break;
    if (action.action === 'FAIL') throw new Error(action.reason || `Milestone ${index + 1} failed.`);
    const previousState = state;
    const execution = await adapter.executeAction(action);
    const settled = await settleState({ captureState: adapter.captureState, previousState, options });
    state = settled.state;
    const isControlMilestone = /CLICK_CONTROL|SEMANTIC_CONTROL/.test(milestone.kind);
    const isMessageMilestone = /SEND_MESSAGE|REQUIRED_CUSTOMER_MESSAGE/.test(milestone.kind);
    const isValidationMilestone = /VALIDATION|VERIFY|ASSERT/.test(milestone.kind);
    let judgement;
    try {
      judgement = await judgeStructuredOutcome({ scenario: { businessObjective: scenario.businessObjective, activeMilestone: milestone, successConditions: scenario.successConditions, failureConditions: scenario.failureConditions }, previousState, action, result: execution, currentState: state, memory });
    } catch (error) {
      judgement = { goalStatus: 'IN_PROGRESS', madeProgress: settled.evidence.meaningfulChangeSeen, shouldContinue: true, score: 0.5, reason: `Judge unavailable: ${error.message}`, evidence: [], fallbackUsed: true };
    }

    // A successfully executed customer message or control action is a transition step,
    // not an application assertion. Generative wording and the next controls may differ
    // from the judge's prediction. Observable state change therefore takes precedence
    // over a semantic FAILED/BLOCKED verdict for these milestone types.
    if ((isControlMilestone || isMessageMilestone) && settled.evidence.meaningfulChangeSeen) {
      judgement = {
        ...judgement,
        goalStatus: 'IN_PROGRESS',
        madeProgress: true,
        shouldContinue: true,
        transitionAccepted: true,
        originalGoalStatus: judgement.goalStatus,
        reason: `Transition completed with observable UI progress. ${judgement.reason || ''}`.trim(),
      };
    }

    // Only validation milestones may turn a semantic verdict directly into an
    // application failure. Transition milestones fail only when execution produced
    // no observable progress and the judge confirms that the journey is blocked.
    if (isValidationMilestone && judgement.goalStatus === 'FAILED') {
      throw new Error(judgement.reason || `Milestone ${index + 1} failed.`);
    }
    if (judgement.goalStatus === 'BLOCKED' && !settled.evidence.meaningfulChangeSeen) {
      throw new Error(judgement.reason || `Milestone ${index + 1} is blocked.`);
    }
    if ((isControlMilestone || isMessageMilestone) && judgement.goalStatus === 'FAILED' && !settled.evidence.meaningfulChangeSeen) {
      throw new Error(judgement.reason || `Milestone ${index + 1} did not produce observable progress.`);
    }
    memory.conversationSummary = judgement.conversationSummary || memory.conversationSummary;
    memory.completedProgress = [...memory.completedProgress, milestone.name || milestone.intent || `Milestone ${index + 1}`];
    const record = { step: index + 1, milestone, action, execution, judgement, settleEvidence: settled.evidence, state };
    history.push(record);
    if (onStep) await onStep(record);
  }
  return { status: 'COMPLETE', steps: history, memory };
}

async function runSemanticJourney({ scenario, adapter, maxTurns = 25, options = {}, onTurn }) {
  if (!scenario) throw new Error('Semantic journey requires scenario text or a semantic contract.');
  if (!adapter?.captureState || !adapter?.executeAction) throw new Error('Semantic journey requires captureState and executeAction adapter methods.');

  const history = [];
  const memory = {
    conversationSummary: '',
    goalStatus: 'IN_PROGRESS',
    completedProgress: [],
    unresolvedRequests: [],
    noProgressTurns: 0,
    lastState: null,
  };

  let currentState = await adapter.captureState();
  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const action = await decideNextAction({ scenario, state: currentState, history, memory });
    const plannerMetadata = action._llm;
    delete action._llm;

    if (action.action === 'COMPLETE') {
      return { status: 'COMPLETE', turns: history, memory, plannerMetadata };
    }
    if (action.action === 'FAIL') {
      throw new Error(action.reason || 'Semantic planner marked the journey as failed.');
    }

    const execution = await adapter.executeAction(action);
    const settled = await settleState({ captureState: adapter.captureState, previousState: currentState, options });
    const previousState = currentState;
    currentState = settled.state;

    let judgement;
    try {
      judgement = await judgeStructuredOutcome({ scenario, previousState, action, result: execution, currentState, memory });
    } catch (error) {
      judgement = {
        goalStatus: 'IN_PROGRESS',
        madeProgress: settled.evidence.meaningfulChangeSeen,
        shouldContinue: true,
        score: 0.5,
        reason: `Semantic judge unavailable; continuing from observable state: ${error.message}`,
        conversationSummary: memory.conversationSummary,
        completedProgress: memory.completedProgress,
        unresolvedRequests: memory.unresolvedRequests,
        evidence: [],
        fallbackUsed: true,
      };
    }

    memory.conversationSummary = judgement.conversationSummary || memory.conversationSummary;
    memory.goalStatus = judgement.goalStatus || 'IN_PROGRESS';
    memory.completedProgress = judgement.completedProgress || memory.completedProgress;
    memory.unresolvedRequests = judgement.unresolvedRequests || memory.unresolvedRequests;
    memory.noProgressTurns = judgement.madeProgress === true ? 0 : memory.noProgressTurns + 1;
    memory.lastState = previousState;

    const record = { turn, action, execution, judgement, settleEvidence: settled.evidence, state: currentState };
    history.push(record);
    if (onTurn) await onTurn(record);

    if (judgement.goalStatus === 'COMPLETE') return { status: 'COMPLETE', turns: history, memory };
    if (judgement.goalStatus === 'FAILED') throw new Error(judgement.reason || 'Application journey failed.');
    if (judgement.goalStatus === 'BLOCKED' && !settled.evidence.meaningfulChangeSeen) throw new Error(judgement.reason || 'Application journey is blocked.');
  }

  throw new Error(`Semantic journey exceeded ${maxTurns} turns without proving completion.`);
}

module.exports = { runSemanticJourney, runGeneratedJourney, settleState };
