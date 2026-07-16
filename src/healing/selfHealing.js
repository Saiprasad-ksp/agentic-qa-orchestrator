'use strict';

const fs = require('fs');
const path = require('path');
const { readEnv } = require('../env');

function classifyFailure(error) {
  const message = String(error?.message || error || '');
  if (/timeout|not found|strict mode|locator|element/i.test(message)) return 'locator_or_timing';
  if (/network|ERR_|ECONN|ENOTFOUND|503|502|500/i.test(message)) return 'environment';
  if (/visual|pixel|mismatch/i.test(message)) return 'visual';
  if (/judge|semantic|response|chatbot/i.test(message)) return 'generative_validation';
  return 'product_or_unknown';
}

async function withSelfHealing({ operation, fallbacks = [], context = {}, onEvidence }) {
  const attempts = [{ name: 'primary', fn: operation }, ...fallbacks];
  let lastError;
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    try {
      const value = await attempt.fn();
      return { value, healed: index > 0, strategy: attempt.name, attempts: index + 1 };
    } catch (error) {
      lastError = error;
      if (onEvidence) await onEvidence({ error, attempt: attempt.name, context }).catch(() => {});
    }
  }
  lastError.failureType = classifyFailure(lastError);
  throw lastError;
}

function writeHealingCandidate(projectRoot, payload) {
  const targetEnv = readEnv('TARGET_ENV', 'UAT').toUpperCase();
  const directory = path.join(projectRoot, 'reports', 'healing');
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, `${Date.now()}-${payload.scenario || 'scenario'}.json`);
  fs.writeFileSync(filePath, JSON.stringify({ targetEnv, autoApplyAllowed: targetEnv !== 'PROD' && readEnv('AUTO_APPLY_HEALING', 'false') === 'true', ...payload }, null, 2));
  return filePath;
}

module.exports = { classifyFailure, withSelfHealing, writeHealingCandidate };
