'use strict';

const { loadProjectEnv, readEnv, requireEnv } = require('./src/env');
loadProjectEnv('.env.mobile', '.env.browserstack', '.env.llm');

const runTarget = readEnv('RUN_TARGET', 'local').toLowerCase();
const isBrowserStack = runTarget === 'browserstack';
const mobilePlatform = readEnv('MOBILE_PLATFORM', 'android').toLowerCase();
const isIOS = mobilePlatform === 'ios';

function appReference() {
  const env = readEnv('TARGET_ENV', 'UAT').toUpperCase();
  return readEnv('BROWSERSTACK_APP_HASH') || readEnv(env === 'PROD' ? 'APP_PROD' : 'APP_UAT');
}

const shared = {
  platformName: isIOS ? 'iOS' : 'Android',
  'appium:automationName': isIOS ? 'XCUITest' : 'UiAutomator2',
  'appium:deviceName': readEnv('DEVICE_NAME', isIOS ? 'iPhone 15' : 'Pixel_7_Pro_Emulator'),
  'appium:platformVersion': readEnv('PLATFORM_VERSION', isIOS ? '17.0' : '14.0'),
  'appium:newCommandTimeout': Number(readEnv('APPIUM_NEW_COMMAND_TIMEOUT', '300')),
};

const browserStackCaps = {
  ...shared,
  'appium:app': appReference(),
  'bstack:options': {
    projectName: readEnv('BROWSERSTACK_PROJECT', 'Agentic QA Orchestrator'),
    buildName: readEnv('BROWSERSTACK_BUILD', `${readEnv('TARGET_ENV', 'UAT')}-${mobilePlatform}`),
    sessionName: readEnv('BROWSERSTACK_SESSION', process.env.QA_RUN_ID || 'QA scenario'),
    debug: true,
    networkLogs: readEnv('BS_NETWORK_LOGS', 'false') === 'true',
  },
};

const localCaps = isIOS ? {
  ...shared,
  'appium:bundleId': requireEnv('IOS_BUNDLE_ID', 'Set IOS_BUNDLE_ID in .env.mobile.'),
  ...(readEnv('IOS_APP_PATH') ? { 'appium:app': readEnv('IOS_APP_PATH') } : {}),
} : {
  ...shared,
  'appium:appPackage': readEnv('APP_PACKAGE', 'com.woolworths.shop'),
  'appium:appActivity': readEnv('APP_ACTIVITY', '.MainActivity'),
  ...(readEnv('ANDROID_APP_PATH') ? { 'appium:app': readEnv('ANDROID_APP_PATH') } : {}),
};

exports.config = {
  ...(isBrowserStack ? {
    user: requireEnv('BROWSERSTACK_USERNAME', 'Put this in .env.browserstack.'),
    key: requireEnv('BROWSERSTACK_ACCESS_KEY', 'Put this in .env.browserstack.'),
    services: ['browserstack'], hostname: 'hub.browserstack.com', protocol: 'https', port: 443, path: '/wd/hub',
  } : {
    hostname: readEnv('APPIUM_HOST', 'localhost'), protocol: readEnv('APPIUM_PROTOCOL', 'http'),
    port: Number(readEnv('APPIUM_PORT', '4723')), path: readEnv('APPIUM_PATH', '/'), services: [],
  }),
  specs: [readEnv('WDIO_SPEC', './generated-specs/mobile/**/*.spec.js')],
  maxInstances: 1,
  capabilities: [isBrowserStack ? browserStackCaps : localCaps],
  logLevel: readEnv('WDIO_LOG_LEVEL', 'info'),
  waitforTimeout: Number(readEnv('WDIO_WAITFOR_TIMEOUT_MS', '20000')),
  connectionRetryTimeout: Number(readEnv('WDIO_CONNECTION_TIMEOUT_MS', '120000')),
  connectionRetryCount: 2,
  framework: 'mocha',
  reporters: ['spec'],
  mochaOpts: { ui: 'bdd', timeout: Number(readEnv('WDIO_MOCHA_TIMEOUT_MS', '600000')) },
  afterTest: async function (_test, _context, result) {
    if (!result.passed && process.env.QA_SCREENSHOTS_DIR) {
      const fs = require('fs');
      const path = require('path');
      fs.mkdirSync(process.env.QA_SCREENSHOTS_DIR, { recursive: true });
      await browser.saveScreenshot(path.join(process.env.QA_SCREENSHOTS_DIR, `mobile-failure-${Date.now()}.png`)).catch(() => {});
    }
  },
};
