'use strict';

const fs = require('fs');
const path = require('path');
const {
  spawnSync,
} = require('child_process');

const projectRoot =
  path.resolve(__dirname, '..');

function run(
  label,
  command,
  args,
  extraEnv = {},
  allowFailure = false
) {
  console.log('');
  console.log(`▶ ${label}`);
  console.log(
    `  ${command} ${args.join(' ')}`
  );
  console.log('');

  const result = spawnSync(
    command,
    args,
    {
      cwd: projectRoot,
      stdio: 'inherit',
      env: {
        ...process.env,
        ...extraEnv,
      },
    }
  );

  const status =
    Number.isInteger(result.status)
      ? result.status
      : 1;

  if (
    status !== 0 &&
    !allowFailure
  ) {
    throw new Error(
      `${label} failed with ` +
      `exit code ${status}.`
    );
  }

  return status;
}

function resolveScenarioPath(argument) {
  const candidates = [
    path.resolve(
      projectRoot,
      argument
    ),

    path.resolve(
      projectRoot,
      'scenarios',
      argument
    ),

    path.resolve(
      projectRoot,
      'scenarios',
      'web',
      argument
    ),

    path.resolve(
      projectRoot,
      'scenarios',
      'mobile',
      argument
    ),
  ];

  const match = candidates.find(
    candidate =>
      fs.existsSync(candidate)
  );

  if (!match) {
    throw new Error(
      `Scenario file not found.\n` +
      `Checked:\n` +
      candidates.join('\n')
    );
  }

  return match;
}

function readScenarioValue(
  text,
  key
) {
  const pattern = new RegExp(
    `^${key}:\\s*(.+)$`,
    'im'
  );

  return (
    text.match(pattern)?.[1]
      ?.trim() ||
    ''
  );
}

function inferPlatform(text) {
  const value =
    readScenarioValue(
      text,
      'PLATFORM'
    ) ||
    'Web';

  if (/android/i.test(value)) {
    return 'android';
  }

  if (/ios/i.test(value)) {
    return 'ios';
  }

  if (/mobile/i.test(value)) {
    return String(
      process.env
        .MOBILE_PLATFORM ||
      'android'
    ).toLowerCase();
  }

  return 'web';
}

function inferScenarioType(text) {
  const declared =
    readScenarioValue(
      text,
      'TEST_TYPE'
    ) ||
    readScenarioValue(
      text,
      'TYPE'
    );

  if (
    /generative/i.test(declared) ||
    /@generative\b/i.test(text) ||
    /\bCONVERSATION\s*:/i.test(text)
  ) {
    return 'generative';
  }

  return 'deterministic';
}

function readJson(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(
    fs.readFileSync(
      filePath,
      'utf8'
    )
  );
}

function validateManifest({
  manifestPath,
  scenarioType,
}) {
  const manifest =
    readJson(manifestPath);

  if (!manifest) {
    throw new Error(
      `Discovery manifest not created: ` +
      manifestPath
    );
  }

  const errors = [];

  if (
    Number(manifest.status) !== 0
  ) {
    errors.push(
      `status=${manifest.status}`
    );
  }

  const evidenceFiles =
    Array.isArray(
      manifest.evidenceFiles
    )
      ? manifest.evidenceFiles
      : [];

  const screenshotFiles =
    Array.isArray(
      manifest.screenshotFiles
    )
      ? manifest.screenshotFiles
      : [];

  if (!evidenceFiles.length) {
    errors.push(
      'no evidence files'
    );
  }

  if (
    Array.isArray(
      manifest.blockedSpecWrites
    ) &&
    manifest.blockedSpecWrites.length
  ) {
    errors.push(
      'spec write attempted ' +
      'during discovery'
    );
  }

  if (
    Array.isArray(
      manifest.attemptedSpecChanges
    ) &&
    manifest
      .attemptedSpecChanges.length
  ) {
    errors.push(
      'generated specs changed ' +
      'during discovery'
    );
  }

  const generativeEvidence =
    evidenceFiles.some(file => {
      const value =
        typeof file === 'string'
          ? file
          : JSON.stringify(file);

      return (
        /transcript|metrics|report/i
          .test(value)
      );
    });

  if (
    scenarioType === 'generative'
  ) {
    if (!generativeEvidence) {
      errors.push(
        'no generative transcript ' +
        'or metrics evidence'
      );
    }
  } else if (
    !screenshotFiles.length
  ) {
    errors.push(
      'no screenshots'
    );
  }

  if (errors.length) {
    throw new Error(
      `Discovery evidence rejected: ` +
      errors.join(', ')
    );
  }

  return manifest;
}

function buildReport({
  scenarioName,
  scenarioType,
  platform,
  lifecycleStatus,
  sharedEnv,
}) {
  const reportName =
    process.env.REPORT_NAME ||
    `${scenarioName}-report`;

  const reportPath =
    path.join(
      projectRoot,
      'reports',
      'shareable',
      `${reportName}.html`
    );

  const status = run(
    'Build shareable report',
    process.execPath,
    [
      path.join(
        projectRoot,
        'scripts',
        'build-shareable-report.js'
      ),
      reportName,
    ],
    {
      ...sharedEnv,

      QA_SCENARIO_NAME:
        scenarioName,

      QA_SCENARIO_TYPE:
        scenarioType,

      QA_PLATFORM:
        platform,

      QA_LIFECYCLE_STATUS:
        lifecycleStatus,
    },
    true
  );

  if (status !== 0) {
    console.warn(
      `⚠️ Shareable report builder ` +
      `failed with exit code ${status}.`
    );

    return null;
  }

  if (!fs.existsSync(reportPath)) {
    console.warn(
      `⚠️ Shareable report was not ` +
      `created: ${reportPath}`
    );

    return null;
  }

  console.log('');
  console.log(
    `📊 Shareable report: ` +
    reportPath
  );

  const shouldOpen =
    String(
      process.env.CI ||
      'false'
    ).toLowerCase() !== 'true' &&
    String(
      process.env.OPEN_REPORT ||
      'true'
    ).toLowerCase() === 'true';

  if (
    shouldOpen &&
    process.platform === 'darwin'
  ) {
    spawnSync(
      'open',
      [reportPath],
      {
        cwd: projectRoot,
        stdio: 'inherit',
      }
    );
  }

  return reportPath;
}

function main() {
  const argument =
    process.argv[2];

  if (!argument) {
    throw new Error(
      'Usage: npm run ' +
      'scenario:build-and-run -- ' +
      '<scenario.txt>'
    );
  }

  const scenarioPath =
    resolveScenarioPath(argument);

  const scenarioText =
    fs.readFileSync(
      scenarioPath,
      'utf8'
    );

  const scenarioName =
    path.basename(
      scenarioPath,
      path.extname(
        scenarioPath
      )
    );

  const scenarioFile =
    path.basename(
      scenarioPath
    );

  const platform =
    inferPlatform(
      scenarioText
    );

  const scenarioType =
    inferScenarioType(
      scenarioText
    );

  const runId =
    `${new Date()
      .toISOString()
      .replace(/[:.]/g, '-')}` +
    `-${scenarioName}`;

  const runDir =
    path.join(
      projectRoot,
      'artifacts',
      'runs',
      runId
    );

  const screenshotsDir =
    path.join(
      runDir,
      'screenshots'
    );

  const evidenceDir =
    path.join(
      runDir,
      'evidence'
    );

  const runReportsDir =
    path.join(
      runDir,
      'reports'
    );

  for (const directory of [
    runDir,
    screenshotsDir,
    evidenceDir,
    runReportsDir,
  ]) {
    fs.mkdirSync(
      directory,
      {
        recursive: true,
      }
    );
  }

  const sharedEnv = {
    QA_RUN_ID:
      runId,

    QA_RUN_DIR:
      runDir,

    QA_SCREENSHOTS_DIR:
      screenshotsDir,

    QA_EVIDENCE_DIR:
      evidenceDir,

    QA_REPORTS_DIR:
      runReportsDir,

    QA_SCENARIO_PATH:
      scenarioPath,

    QA_SCENARIO_NAME:
      scenarioName,

    QA_SCENARIO_TYPE:
      scenarioType,

    QA_PLATFORM:
      platform,
  };

  const relativeScenarioPath =
    path.relative(
      projectRoot,
      scenarioPath
    );

  const discoveryArgument =
    path.relative(
      path.join(
        projectRoot,
        'scenarios'
      ),
      scenarioPath
    )
    .replace(/\\/g, '/');

  const manifestPath =
    path.join(
      projectRoot,
      'reports',
      'discovery',
      `${scenarioName}.manifest.json`
    );

  const generatedFolder =
    platform === 'web'
      ? 'web'
      : 'mobile';

  const specPath =
    path.join(
      projectRoot,
      'generated-specs',
      generatedFolder,
      `${scenarioName}.spec.js`
    );

  let lifecycleError = null;

  console.log('');
  console.log(
    process.env.QA_FRAMEWORK_NAME ||
    'AGENTIC QA ORCHESTRATOR'
  );
  console.log(
    `Scenario: ${scenarioFile}`
  );
  console.log(
    `Scenario path: ` +
    relativeScenarioPath
  );
  console.log(
    `Platform: ${platform}`
  );
  console.log(
    `Type: ${scenarioType}`
  );
  console.log(
    `Run: ${runId}`
  );

  try {
    run(
      'Clean old execution history',
      process.execPath,
      [
        path.join(
          projectRoot,
          'scripts',
          'cleanup-run-history.js'
        ),
      ],
      sharedEnv
    );

    run(
      'Discovery',
      process.execPath,
      [
        path.join(
          projectRoot,
          'scripts',
          'run-discovery.js'
        ),
        discoveryArgument,
      ],
      {
        ...sharedEnv,

        AGENT_RUN_MODE:
          'discover',

        AUTO_SAVE_SPEC:
          'false',

        AUTO_RUN_GENERATED_SPEC:
          'false',
      }
    );

    validateManifest({
      manifestPath,
      scenarioType,
    });

    run(
      'Generate and validate spec',
      process.execPath,
      [
        path.join(
          projectRoot,
          'scripts',
          'generate-spec-from-last-run.js'
        ),
        scenarioPath,
      ],
      {
        ...sharedEnv,
        AGENT_RUN_MODE:
          'generate',
      }
    );

    if (!fs.existsSync(specPath)) {
      throw new Error(
        `Generated spec missing: ` +
        specPath
      );
    }

    const runGeneratedSpec =
      String(
        process.env
          .RUN_GENERATED_SPEC ||
        'false'
      ).toLowerCase() === 'true';

    if (runGeneratedSpec) {
      let executionStatus = 0;

      if (platform === 'web') {
        const args = [
          'playwright',
          'test',
          specPath,
          '--project=chromium',
        ];

        if (
          String(
            process.env.HEADLESS ||
            'true'
          ).toLowerCase() ===
          'false'
        ) {
          args.push('--headed');
        }

        executionStatus = run(
          'Execute generated ' +
          'Playwright spec',
          'npx',
          args,
          {
            ...sharedEnv,
            AGENT_RUN_MODE:
              'execute',
          },
          true
        );
      } else {
        executionStatus = run(
          'Execute generated ' +
          'Appium/WebdriverIO spec',
          'npx',
          [
            'wdio',
            'run',
            'wdio.conf.js',
            '--spec',
            specPath,
          ],
          {
            ...sharedEnv,
            AGENT_RUN_MODE:
              'execute',

            MOBILE_PLATFORM:
              platform,
          },
          true
        );
      }

      if (executionStatus !== 0) {
        throw new Error(
          `Generated ${platform} ` +
          `spec failed with exit ` +
          `code ${executionStatus}.`
        );
      }
    }
  } catch (error) {
    lifecycleError = error;
  } finally {
    const shouldBuildReport =
      String(
        process.env
          .BUILD_SHAREABLE_REPORT ||
        'false'
      ).toLowerCase() === 'true';

    if (shouldBuildReport) {
      buildReport({
        scenarioName,
        scenarioType,
        platform,

        lifecycleStatus:
          lifecycleError
            ? 'FAILED'
            : 'PASSED',

        sharedEnv,
      });
    }
  }

  if (lifecycleError) {
    throw lifecycleError;
  }

  console.log('');
  console.log(
    '✅ Lifecycle complete'
  );
  console.log(
    `Spec: ${specPath}`
  );
  console.log(
    `Run evidence: ${runDir}`
  );
}

try {
  main();
} catch (error) {
  console.error('');
  console.error(
    `❌ ${error.stack || error.message}`
  );
  process.exit(1);
}
