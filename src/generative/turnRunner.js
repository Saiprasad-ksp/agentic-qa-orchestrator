'use strict';

const fs = require('fs');
const path = require('path');

async function runConversationTurns({ turns, sendAndJudge, outputDir, testInfo }) {
  const results = [];
  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index];
    const result = await sendAndJudge(turn);
    results.push({ index: index + 1, ...result });
    if (result.judgement?.passed === false) {
      const error = new Error(`Olive semantic validation failed at turn ${index + 1}: ${result.judgement.summary || 'No summary'}`);
      error.turnResult = result;
      throw error;
    }
  }
  fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, 'olive-conversation.json');
  fs.writeFileSync(filePath, JSON.stringify(results, null, 2));
  if (testInfo) await testInfo.attach('olive-conversation.json', { path: filePath, contentType: 'application/json' });
  return results;
}

module.exports = { runConversationTurns };
