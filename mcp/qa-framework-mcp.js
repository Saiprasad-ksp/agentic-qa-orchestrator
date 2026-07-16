const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const projectRoot = path.resolve(__dirname, '..');
const scenariosDir = path.join(projectRoot, 'scenarios');
const generatedSpecsDir = path.join(projectRoot, 'generated-specs');
const reportsDir = path.join(projectRoot, 'reports');

function runCommand(command, args, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: projectRoot,
      env: {
        ...process.env,
        ...env,
      },
      shell: false,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', data => {
      stdout += data.toString();
    });

    child.stderr.on('data', data => {
      stderr += data.toString();
    });

    child.on('close', code => {
      resolve({
        code,
        stdout,
        stderr,
        passed: code === 0,
      });
    });
  });
}

function listTxtScenarios() {
  if (!fs.existsSync(scenariosDir)) return [];

  return fs.readdirSync(scenariosDir)
    .filter(file => file.endsWith('.txt'))
    .map(file => {
      const fullPath = path.join(scenariosDir, file);
      const content = fs.readFileSync(fullPath, 'utf8');

      const tags = (content.match(/^TAGS:\s*(.+)$/mi)?.[1] || '')
        .split(/\s+/)
        .filter(Boolean);

      const platform = content.match(/^PLATFORM:\s*(.+)$/mi)?.[1]?.trim() || 'Unknown';
      const scenario = content.match(/^SCENARIO:\s*(.+)$/mi)?.[1]?.trim() || file;

      return {
        file,
        scenario,
        platform,
        tags,
      };
    });
}

function listGeneratedSpecs() {
  if (!fs.existsSync(generatedSpecsDir)) return [];

  const specs = [];

  function walk(dir) {
    for (const item of fs.readdirSync(dir)) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);

      if (stat.isDirectory()) {
        walk(fullPath);
      } else if (item.endsWith('.spec.js')) {
        specs.push(path.relative(projectRoot, fullPath));
      }
    }
  }

  walk(generatedSpecsDir);
  return specs;
}

function latestReport() {
  if (!fs.existsSync(reportsDir)) return null;

  const reports = fs.readdirSync(reportsDir)
    .filter(file => file.endsWith('.report.html'))
    .map(file => {
      const fullPath = path.join(reportsDir, file);
      return {
        file,
        path: fullPath,
        modifiedMs: fs.statSync(fullPath).mtimeMs,
      };
    })
    .sort((a, b) => b.modifiedMs - a.modifiedMs);

  return reports[0] || null;
}

const server = new Server(
  {
    name: 'gemini-qa-agent-framework',
    version: '1.0.0',
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'qa_list_scenarios',
      description: 'List available non-technical .txt QA scenarios with tags and platform.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'qa_list_generated_specs',
      description: 'List generated Playwright/WebdriverIO spec files that can be run in CI.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'qa_generate_from_txt',
      description: 'Run the agentic first-run flow for one .txt scenario. This uses Gemini + MCP to explore and generate/update framework evidence/specs.',
      inputSchema: {
        type: 'object',
        properties: {
          scenarioFile: {
            type: 'string',
            description: 'Scenario filename from scenarios folder, for example web-helpcenter-faq-audit.txt',
          },
          targetEnv: {
            type: 'string',
            enum: ['UAT', 'PROD'],
            description: 'Target environment.',
          },
          executionTarget: {
            type: 'string',
            enum: ['local', 'browserstack'],
            description: 'Where to execute the scenario.',
          },
          headless: {
            type: 'boolean',
            description: 'Run browser in headless mode or visible mode.',
          },
        },
        required: ['scenarioFile'],
      },
    },
    {
      name: 'qa_run_spec',
      description: 'Run a generated spec file directly without LLM. This is the normal pipeline-style execution.',
      inputSchema: {
        type: 'object',
        properties: {
          specPath: {
            type: 'string',
            description: 'Path to generated spec, for example generated-specs/olive-generative-chat.spec.js',
          },
          platform: {
            type: 'string',
            enum: ['web', 'mobile'],
          },
          targetEnv: {
            type: 'string',
            enum: ['UAT', 'PROD'],
          },
          executionTarget: {
            type: 'string',
            enum: ['local', 'browserstack'],
          },
          headless: {
            type: 'boolean',
          },
        },
        required: ['specPath', 'platform'],
      },
    },
    {
      name: 'qa_run_by_tag',
      description: 'Run generated or scenario tests by tag using the framework tag runner.',
      inputSchema: {
        type: 'object',
        properties: {
          tag: {
            type: 'string',
            description: 'Tag or comma-separated tags, for example @faq or @faq,@web',
          },
          targetEnv: {
            type: 'string',
            enum: ['UAT', 'PROD'],
          },
          executionTarget: {
            type: 'string',
            enum: ['local', 'browserstack'],
          },
        },
        required: ['tag'],
      },
    },
    {
      name: 'qa_open_latest_report',
      description: 'Return the latest generated HTML report path.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'qa_repair_last_failure',
      description: 'Run repair mode for the last failed test. Self-healing should run first; LLM repair is used only if enabled.',
      inputSchema: {
        type: 'object',
        properties: {
          allowLlmRepair: {
            type: 'boolean',
            description: 'If true, the framework may use Gemini to inspect UI and update locator/spec files.',
          },
          targetEnv: {
            type: 'string',
            enum: ['UAT', 'PROD'],
          },
          executionTarget: {
            type: 'string',
            enum: ['local', 'browserstack'],
          },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args = {} } = request.params;

  try {
    if (name === 'qa_list_scenarios') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(listTxtScenarios(), null, 2),
          },
        ],
      };
    }

    if (name === 'qa_list_generated_specs') {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(listGeneratedSpecs(), null, 2),
          },
        ],
      };
    }

    if (name === 'qa_generate_from_txt') {
      const scenarioPath = path.join(scenariosDir, args.scenarioFile);

      if (!fs.existsSync(scenarioPath)) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Scenario file not found: ${scenarioPath}`,
            },
          ],
        };
      }

      const env = {
        TARGET_ENV: args.targetEnv || process.env.TARGET_ENV || 'UAT',
        RUN_TARGET: args.executionTarget || process.env.RUN_TARGET || 'local',
        MCP_SERVER_MODE: 'local',
        HEADLESS: args.headless === false ? 'false' : 'true',
        PLAYWRIGHT_SLOW_MO_MS: args.headless === false ? '250' : '0',
      };

      const result = await runCommand(
        process.execPath,
        ['agent-hybrid-client.js', args.scenarioFile],
        env,
      );

      const report = latestReport();

      return {
        isError: !result.passed,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              command: `node agent-hybrid-client.js ${args.scenarioFile}`,
              env,
              exitCode: result.code,
              passed: result.passed,
              latestReport: report ? report.path : null,
              stdout: result.stdout.slice(-12000),
              stderr: result.stderr.slice(-6000),
            }, null, 2),
          },
        ],
      };
    }

    if (name === 'qa_run_spec') {
      const specPath = path.resolve(projectRoot, args.specPath);

      if (!fs.existsSync(specPath)) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Spec file not found: ${specPath}`,
            },
          ],
        };
      }

      const env = {
        TARGET_ENV: args.targetEnv || process.env.TARGET_ENV || 'UAT',
        RUN_TARGET: args.executionTarget || process.env.RUN_TARGET || 'local',
        HEADLESS: args.headless === false ? 'false' : 'true',
        LLM_ENABLED: process.env.LLM_ENABLED || 'false',
        OLIVE_VALIDATION_MODE: process.env.OLIVE_VALIDATION_MODE || 'deterministic_first',
      };

      const isMobile = args.platform === 'mobile';

      const commandArgs = isMobile
        ? ['wdio', 'run', 'wdio.conf.js', '--spec', specPath]
        : ['playwright', 'test', specPath, '--project=chromium'];

      if (!isMobile && args.headless === false) {
        commandArgs.push('--headed');
      }

      const result = await runCommand('npx', commandArgs, env);
      const report = latestReport();

      return {
        isError: !result.passed,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              command: `npx ${commandArgs.join(' ')}`,
              env,
              exitCode: result.code,
              passed: result.passed,
              latestReport: report ? report.path : null,
              stdout: result.stdout.slice(-12000),
              stderr: result.stderr.slice(-6000),
            }, null, 2),
          },
        ],
      };
    }

    if (name === 'qa_run_by_tag') {
      const runnerPath = path.join(projectRoot, 'scripts', 'run-by-tag.js');

      if (!fs.existsSync(runnerPath)) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: 'scripts/run-by-tag.js does not exist yet. Create the tag runner first.',
            },
          ],
        };
      }

      const env = {
        TARGET_ENV: args.targetEnv || process.env.TARGET_ENV || 'UAT',
        RUN_TARGET: args.executionTarget || process.env.RUN_TARGET || 'local',
        MCP_SERVER_MODE: 'local',
      };

      const result = await runCommand(
        process.execPath,
        ['scripts/run-by-tag.js', '--tag', args.tag, '--target', env.RUN_TARGET],
        env,
      );

      const report = latestReport();

      return {
        isError: !result.passed,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              command: `node scripts/run-by-tag.js --tag ${args.tag} --target ${env.RUN_TARGET}`,
              env,
              exitCode: result.code,
              passed: result.passed,
              latestReport: report ? report.path : null,
              stdout: result.stdout.slice(-12000),
              stderr: result.stderr.slice(-6000),
            }, null, 2),
          },
        ],
      };
    }

    if (name === 'qa_open_latest_report') {
      const report = latestReport();

      return {
        isError: !report,
        content: [
          {
            type: 'text',
            text: report
              ? JSON.stringify(report, null, 2)
              : 'No HTML report found under reports/*.report.html',
          },
        ],
      };
    }

    if (name === 'qa_repair_last_failure') {
      const env = {
        TARGET_ENV: args.targetEnv || process.env.TARGET_ENV || 'UAT',
        RUN_TARGET: args.executionTarget || process.env.RUN_TARGET || 'local',
        SELF_HEAL: 'true',
        AI_REPAIR_ON_FAILURE: args.allowLlmRepair ? 'true' : 'false',
        LLM_ENABLED: args.allowLlmRepair ? 'true' : 'false',
      };

      const repairScript = path.join(projectRoot, 'scripts', 'repair-last-failure.js');

      if (!fs.existsSync(repairScript)) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                message: 'Repair MCP hook is connected, but scripts/repair-last-failure.js is not implemented yet.',
                nextStep: 'Create repair-last-failure.js to read last failure evidence, try locator self-heal, then optionally call LLM repair.',
                env,
              }, null, 2),
            },
          ],
        };
      }

      const result = await runCommand(
        process.execPath,
        ['scripts/repair-last-failure.js'],
        env,
      );

      const report = latestReport();

      return {
        isError: !result.passed,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              command: 'node scripts/repair-last-failure.js',
              env,
              exitCode: result.code,
              passed: result.passed,
              latestReport: report ? report.path : null,
              stdout: result.stdout.slice(-12000),
              stderr: result.stderr.slice(-6000),
            }, null, 2),
          },
        ],
      };
    }

    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Unknown QA framework tool: ${name}`,
        },
      ],
    };
  } catch (error) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: error.stack || error.message,
        },
      ],
    };
  }
});

async function main() {
  await server.connect(new StdioServerTransport());
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
