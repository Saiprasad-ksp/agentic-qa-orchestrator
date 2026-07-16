const fs = require('fs');
const path = require('path');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { remote } = require('webdriverio');
const { loadProjectEnv, readEnv, requireEnv } = require('./src/env');

loadProjectEnv('.env.mobile', '.env.browserstack');

let driver = null;

function buildCapabilities() {
  const targetEnv = readEnv('TARGET_ENV', 'UAT').toUpperCase();
  const isBrowserStack = readEnv('RUN_TARGET', 'browserstack').toLowerCase() === 'browserstack';

  if (isBrowserStack) {
    return {
      platformName: 'android',
      'appium:automationName': 'UiAutomator2',
      'appium:platformVersion': readEnv('PLATFORM_VERSION', '13.0'),
      'appium:deviceName': readEnv('DEVICE_NAME', 'Google Pixel 7'),
      'appium:app': readEnv('BROWSERSTACK_APP_HASH') || readEnv(targetEnv === 'PROD' ? 'APP_PROD' : 'APP_UAT'),
      'bstack:options': {
        userName: requireEnv('BROWSERSTACK_USERNAME', 'Add this to .env.browserstack.'),
        accessKey: requireEnv('BROWSERSTACK_ACCESS_KEY', 'Add this to .env.browserstack.'),
        projectName: readEnv('BROWSERSTACK_PROJECT', 'Woolworths Olive Automation'),
        buildName: readEnv('BROWSERSTACK_BUILD', 'Generative-AI-Build'),
        sessionName: readEnv('BROWSERSTACK_SESSION', 'Autonomous Olive Bot Validation'),
      },
    };
  }

  return {
    platformName: 'Android',
    'appium:automationName': 'UiAutomator2',
    'appium:deviceName': readEnv('DEVICE_NAME', 'Pixel_7_Pro_Emulator'),
    'appium:platformVersion': readEnv('PLATFORM_VERSION', '14.0'),
    'appium:appPackage': readEnv('APP_PACKAGE', 'com.woolworths.shop'),
    'appium:appActivity': readEnv('APP_ACTIVITY', '.MainActivity'),
    ...(readEnv('APP_PATH') ? { 'appium:app': readEnv('APP_PATH') } : {}),
  };
}

async function createDriver() {
  const isBrowserStack = readEnv('RUN_TARGET', 'browserstack').toLowerCase() === 'browserstack';
  const capabilities = buildCapabilities();
  const config = isBrowserStack
    ? { protocol: 'https', hostname: 'hub.browserstack.com', port: 443, path: '/wd/hub', logLevel: 'silent', capabilities }
    : {
        protocol: readEnv('APPIUM_PROTOCOL', 'http'),
        hostname: readEnv('APPIUM_HOST', 'localhost'),
        port: Number(readEnv('APPIUM_PORT', '4723')),
        path: readEnv('APPIUM_PATH', '/'),
        logLevel: readEnv('APPIUM_LOG_LEVEL', 'info'),
        capabilities,
      };
  return remote(config);
}

async function getVisibleTexts() {
  const sourceText = [];
  const nativeEls = await driver.$$('//*[@text != "" or @label != "" or @content-desc != ""]');
  for (const el of nativeEls.slice(-80)) {
    const text = (await el.getText().catch(() => '')) ||
      (await el.getAttribute('label').catch(() => '')) ||
      (await el.getAttribute('content-desc').catch(() => ''));
    if (text && text.trim()) sourceText.push(text.trim());
  }
  return [...new Set(sourceText)].join('\n');
}

async function findVisibleInput() {
  const selectors = [
    '//android.widget.EditText',
    '//input | //textarea | //*[@contenteditable="true"]',
    '//*[@class="android.widget.EditText" or contains(@resource-id, "input") or contains(@resource-id, "message")]'
  ];
  for (const selector of selectors) {
    const els = await driver.$$(selector).catch(() => []);
    for (const el of els) {
      if (await el.isDisplayed().catch(() => false)) return el;
    }
  }
  return null;
}

async function pressEnterByContext() {
  const context = await driver.getContext().catch(() => 'NATIVE_APP');
  if (String(context).includes('WEBVIEW')) await driver.keys('Enter');
  else await driver.pressKeyCode(66);
}

const server = new Server(
  { name: 'qa-automation-mobile-olive', version: '2.1.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    { name: 'mobile_start_session', description: 'Initialise the mobile app session locally or on BrowserStack.', inputSchema: { type: 'object', properties: {} } },
    {
      name: 'mobile_click_element',
      description: 'Click a mobile element by text or accessibility id.',
      inputSchema: {
        type: 'object',
        properties: { target: { type: 'string' }, strategy: { type: 'string', enum: ['text', 'accessibilityId'] } },
        required: ['target', 'strategy'],
      },
    },
    { name: 'mobile_type_and_enter', description: 'Type text into the currently visible chat input and submit.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
    { name: 'mobile_read_screen', description: 'Read visible native/webview text for generative bot validation.', inputSchema: { type: 'object', properties: {} } },
    { name: 'mobile_inspect_dom', description: 'Dump current XML/HTML page source.', inputSchema: { type: 'object', properties: {} } },
    { name: 'mobile_list_contexts', description: 'List Appium contexts such as NATIVE_APP and WEBVIEW.', inputSchema: { type: 'object', properties: {} } },
    { name: 'mobile_switch_context', description: 'Switch Appium context.', inputSchema: { type: 'object', properties: { contextName: { type: 'string' } }, required: ['contextName'] } },
    { name: 'mobile_switch_first_webview', description: 'Switch into the first available WEBVIEW context.', inputSchema: { type: 'object', properties: {} } },
    { name: 'mobile_switch_iframe', description: 'Switch into the first iframe inside the current WEBVIEW.', inputSchema: { type: 'object', properties: {} } },
    { name: 'mobile_save_screenshot', description: 'Save a mobile screenshot to reports/screenshots.', inputSchema: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] } },
    { name: 'mobile_start_video', description: 'Start mobile screen recording.', inputSchema: { type: 'object', properties: {} } },
    { name: 'mobile_stop_and_save_video', description: 'Stop screen recording and save MP4.', inputSchema: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] } },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args = {} } = request.params;
  try {
    if (!driver && name !== 'mobile_start_session') throw new Error('Call mobile_start_session first.');

    switch (name) {
      case 'mobile_start_session':
        driver = await createDriver();
        return { content: [{ type: 'text', text: 'Mobile session started.' }] };

      case 'mobile_click_element': {
        const locator = args.strategy === 'accessibilityId'
          ? `~${args.target}`
          : `//*[contains(@text, "${args.target}") or contains(@label, "${args.target}") or contains(@content-desc, "${args.target}")]`;
        const el = await driver.$(locator);
        await el.waitForDisplayed({ timeout: 15000 });
        await el.click();
        return { content: [{ type: 'text', text: `Clicked ${args.target}.` }] };
      }

      case 'mobile_type_and_enter': {
        await driver.pause(1000);
        const input = await findVisibleInput();
        if (!input) throw new Error('No visible chat input was found. Check context/webview/iframe first.');
        await input.setValue(args.text);
        await pressEnterByContext();
        return { content: [{ type: 'text', text: `Typed and submitted: ${args.text}` }] };
      }

      case 'mobile_read_screen':
        return { content: [{ type: 'text', text: await getVisibleTexts() }] };

      case 'mobile_inspect_dom':
        return { content: [{ type: 'text', text: await driver.getPageSource() }] };

      case 'mobile_list_contexts': {
        await driver.pause(2000);
        const contexts = await driver.getContexts();
        return { content: [{ type: 'text', text: `Available contexts: ${contexts.join(', ')}` }] };
      }

      case 'mobile_switch_context':
        await driver.switchContext(args.contextName);
        return { content: [{ type: 'text', text: `Switched into ${args.contextName}.` }] };

      case 'mobile_switch_first_webview': {
        await driver.pause(3000);
        const contexts = await driver.getContexts();
        const webview = contexts.find(ctx => String(ctx).includes('WEBVIEW'));
        if (!webview) throw new Error(`No WEBVIEW context found. Contexts: ${contexts.join(', ')}`);
        await driver.switchContext(webview);
        return { content: [{ type: 'text', text: `Switched into ${webview}.` }] };
      }

      case 'mobile_switch_iframe': {
        await driver.pause(3000);
        const iframe = await driver.$('iframe');
        await iframe.waitForExist({ timeout: 15000 });
        await driver.switchToFrame(iframe);
        return { content: [{ type: 'text', text: 'Switched into first iframe.' }] };
      }

      case 'mobile_save_screenshot': {
        fs.mkdirSync(path.resolve(__dirname, 'reports', 'screenshots'), { recursive: true });
        const filePath = path.resolve(__dirname, 'reports', 'screenshots', `${args.filename.replace(/[^a-z0-9-_]/gi, '_')}.png`);
        await driver.saveScreenshot(filePath);
        return { content: [{ type: 'text', text: `Screenshot saved to ${filePath}` }] };
      }

      case 'mobile_start_video':
        await driver.startRecordingScreen();
        return { content: [{ type: 'text', text: 'Started recording screen.' }] };

      case 'mobile_stop_and_save_video': {
        const videoBase64 = await driver.stopRecordingScreen();
        const filePath = path.resolve(__dirname, args.filename);
        fs.writeFileSync(filePath, videoBase64, 'base64');
        return { content: [{ type: 'text', text: `Saved video to ${filePath}` }] };
      }

      default:
        throw new Error(`Tool not found: ${name}`);
    }
  } catch (error) {
    return { content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true };
  }
});

async function run() {
  await server.connect(new StdioServerTransport());
}

process.on('exit', () => {
  if (driver) driver.deleteSession().catch(() => {});
});

run().catch(error => {
  console.error(error);
  process.exit(1);
});
