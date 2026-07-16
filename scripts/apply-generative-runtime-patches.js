'use strict';

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function replaceOnce(file, oldText, newText, label) {
  const target = path.join(root, file);
  let text = fs.readFileSync(target, 'utf8');
  if (text.includes(newText)) {
    console.log(`Already patched: ${label}`);
    return;
  }
  if (!text.includes(oldText)) {
    throw new Error(`Could not find expected block for ${label} in ${file}`);
  }
  text = text.replace(oldText, newText);
  fs.writeFileSync(target, text, 'utf8');
  console.log(`Patched: ${label}`);
}

replaceOnce(
  'mcp-server.js',
`      case 'pw_open_olive': {
        await olive.open();
        const controls = await olive.dumpVisibleControls(25);

        return {
          content: [{
            type: 'text',
            text: \`Olive chat surface is open and ready.\\nVisible controls after open:\\n\${controls}\`,
          }],
        };
      }
`,
`      case 'pw_open_olive': {
        await olive.open();

        return {
          content: [{
            type: 'text',
            text: JSON.stringify({
              opened: true,
              surface: 'olive_widget',
              inputAvailable: true,
              chatContainerFound: true,
            }),
          }],
        };
      }
`,
  'lean pw_open_olive output',
);

replaceOnce(
  'agent-hybrid-runtime.js',
`        blockedPatterns: { type: 'array', items: { type: 'string' } },
      },
      required: ['userMessage', 'botResponse', 'expectedIntent'],
`,
`        blockedPatterns: { type: 'array', items: { type: 'string' } },
        currentState: { type: 'string' },
        allowedNextStates: { type: 'array', items: { type: 'string' } },
        flowId: { type: 'string' },
        flowContext: { type: 'object' },
      },
      required: ['userMessage', 'botResponse', 'expectedIntent'],
`,
  'flow-aware judge tool schema',
);

replaceOnce(
  'agent-hybrid-runtime.js',
`          blockedPatterns: functionCall.args.blockedPatterns || [],
        });
`,
`          blockedPatterns: functionCall.args.blockedPatterns || [],
          currentState: functionCall.args.currentState || 'START',
          allowedNextStates: functionCall.args.allowedNextStates || [],
          flowId: functionCall.args.flowId || '',
          flowContext: functionCall.args.flowContext || null,
        });
`,
  'pass flow state to judge',
);

replaceOnce(
  'agent-hybrid-runtime.js',
`          blockedPatterns: functionCall.args.blockedPatterns || [],
          passed: Boolean(judgement.passed),
`,
`          blockedPatterns: functionCall.args.blockedPatterns || [],
          currentState: functionCall.args.currentState || 'START',
          allowedNextStates: functionCall.args.allowedNextStates || [],
          flowId: functionCall.args.flowId || '',
          detectedState: judgement.detectedState,
          transitionValid: judgement.transitionValid,
          judgeMode: judgement.judgeMode,
          passed: Boolean(judgement.passed),
`,
  'record flow-aware validation evidence',
);

const runtimePath = path.join(root, 'agent-hybrid-runtime.js');
let runtime = fs.readFileSync(runtimePath, 'utf8');
const instruction = '- When pw_send_olive_message returns JSON, extract botResponse and pass it to verify_generative_response.';
const replacement = `${instruction}\n- Never send fullConversation, whole-page text, or unrelated page controls back to Gemini.\n- Treat login, order selection, item selection, and escalation as valid intermediate states when allowed by the scenario or flow context.`;
if (!runtime.includes('Never send fullConversation')) {
  if (!runtime.includes(instruction)) throw new Error('Could not locate runtime generative instruction block.');
  runtime = runtime.replace(instruction, replacement);
  fs.writeFileSync(runtimePath, runtime, 'utf8');
  console.log('Patched: token-efficient runtime instructions');
}

console.log('\nAll runtime patches completed.');
