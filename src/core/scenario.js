'use strict';

const fs = require('fs');
const path = require('path');

function normaliseTags(value = '') {
  return [...new Set(String(value).match(/@[\w-]+/g) || [])];
}

function parseListBlock(lines, startIndex) {
  const values = [];
  let index = startIndex + 1;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^[A-Z][A-Z0-9 _-]*:\s*/.test(line)) break;
    const item = line.replace(/^\s*[-*]\s*/, '').trim();
    if (item) values.push(item);
  }
  return { values, nextIndex: index - 1 };
}

function parseScenarioText(text) {
  const lines = String(text || '').split(/\r?\n/);
  const result = {
    raw: String(text || ''),
    title: '',
    platform: 'web',
    testType: 'deterministic',
    executionMode: '',
    authRequired: false,
    authFlow: '',
    tags: [],
    goal: '',
    expectations: [],
    journeys: [],
    conversationTurns: [],
    conversationStrategy: [],
    turnGeneration: [],
  };

  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index];
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const header = line.match(/^([A-Z][A-Z0-9 _-]*):\s*(.*)$/);
    if (!header) continue;
    const key = header[1].replace(/\s+/g, '_').toUpperCase();
    const value = header[2].trim();

    if (key === 'TITLE' || key === 'NAME') result.title = value;
    else if (key === 'PLATFORM') result.platform = /android|ios|mobile/i.test(value) ? 'mobile' : 'web';
    else if (key === 'TEST_TYPE' || key === 'TYPE') result.testType = /generative|chat|olive/i.test(value) ? 'generative' : 'deterministic';
    else if (key === 'EXECUTION_MODE') result.executionMode = value.trim().toLowerCase();
    else if (key === 'AUTH_REQUIRED') result.authRequired = /^(true|yes|1)$/i.test(value);
    else if (key === 'AUTH_FLOW') result.authFlow = value.trim().toLowerCase();
    else if (key === 'TAGS') result.tags = normaliseTags(value);
    else if (key === 'GOAL') result.goal = value;
    else if (['EXPECTATIONS', 'ACCEPTANCE_CRITERIA'].includes(key)) {
      const block = parseListBlock(lines, index);
      result.expectations = block.values;
      index = block.nextIndex;
    } else if (['CUSTOMER_JOURNEYS', 'JOURNEYS', 'STEPS'].includes(key)) {
      const block = parseListBlock(lines, index);
      result.journeys = block.values;
      index = block.nextIndex;
    } else if (['CONVERSATION_TURNS', 'MESSAGES'].includes(key)) {
      const block = parseListBlock(lines, index);
      result.conversationTurns = block.values;
      index = block.nextIndex;
    } else if (key === 'CONVERSATION_STRATEGY') {
      const block = parseListBlock(lines, index);
      result.conversationStrategy = block.values;
      index = block.nextIndex;
    } else if (key === 'TURN_GENERATION') {
      const block = parseListBlock(lines, index);
      result.turnGeneration = block.values;
      index = block.nextIndex;
    }
  }

  if (!result.title) result.title = result.goal || 'QA scenario';
  if (!result.tags.includes(result.platform === 'web' ? '@web' : '@mobile')) {
    result.tags.unshift(result.platform === 'web' ? '@web' : '@mobile');
  }
  if (result.testType === 'generative' && !result.tags.includes('@generative')) result.tags.push('@generative');
  return result;
}

function resolveScenarioPath(projectRoot, argument) {
  const candidates = [
    path.resolve(projectRoot, argument),
    path.resolve(projectRoot, 'scenarios', argument),
    path.resolve(projectRoot, 'scenarios', 'web', argument),
    path.resolve(projectRoot, 'scenarios', 'mobile', argument),
  ];
  const found = candidates.find(file => fs.existsSync(file));
  if (!found) throw new Error(`Scenario not found. Checked:\n${candidates.join('\n')}`);
  return found;
}

function readScenario(projectRoot, argument) {
  const filePath = resolveScenarioPath(projectRoot, argument);
  const text = fs.readFileSync(filePath, 'utf8');
  return { filePath, fileName: path.basename(filePath), baseName: path.basename(filePath, path.extname(filePath)), ...parseScenarioText(text) };
}

module.exports = { normaliseTags, parseScenarioText, resolveScenarioPath, readScenario };
