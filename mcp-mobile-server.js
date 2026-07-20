'use strict';

const fs = require('fs');
const path = require('path');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { remote } = require('webdriverio');
const { loadProjectEnv, readEnv, requireEnv } = require('./src/env');

loadProjectEnv('.env.mobile', '.env.browserstack');

let driver = null;
let recording = false;
let latestTargets = new Map();

const reportsRoot = path.resolve(__dirname, process.env.QA_RUN_DIR || 'reports');
const screenshotsDir = path.join(reportsRoot, 'screenshots');
const videosDir = path.join(reportsRoot, 'videos');

function safeName(value, fallback = 'artifact') {
  return String(value || fallback).replace(/[^a-z0-9._-]/gi, '_');
}

function text(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function xpathLiteral(value) {
  const source = String(value || '');
  if (!source.includes('"')) return `"${source}"`;
  if (!source.includes("'")) return `'${source}'`;
  return `concat(${source.split('"').map((part, index) => `${index ? ', \'"\', ' : ''}"${part}"`).join('')})`;
}

function buildCapabilities() {
  const targetEnv = readEnv('TARGET_ENV', 'UAT').toUpperCase();
  const platform = readEnv('MOBILE_PLATFORM', 'android').toLowerCase();
  const isIos = platform === 'ios';
  const isBrowserStack = readEnv('RUN_TARGET', 'browserstack').toLowerCase() === 'browserstack';
  const base = {
    platformName: isIos ? 'iOS' : 'Android',
    'appium:automationName': isIos ? 'XCUITest' : 'UiAutomator2',
    'appium:platformVersion': readEnv('PLATFORM_VERSION', isIos ? '17' : '14'),
    'appium:deviceName': readEnv('DEVICE_NAME', isIos ? 'iPhone 15' : 'Pixel_7_Pro_Emulator'),
  };

  if (isBrowserStack) {
    return {
      ...base,
      'appium:app': readEnv('BROWSERSTACK_APP_HASH') || readEnv(targetEnv === 'PROD' ? 'APP_PROD' : 'APP_UAT'),
      'bstack:options': {
        userName: requireEnv('BROWSERSTACK_USERNAME', 'Add this to .env.browserstack.'),
        accessKey: requireEnv('BROWSERSTACK_ACCESS_KEY', 'Add this to .env.browserstack.'),
        projectName: readEnv('BROWSERSTACK_PROJECT', 'Agentic QA Orchestrator'),
        buildName: readEnv('BROWSERSTACK_BUILD', 'Generative QA Build'),
        sessionName: readEnv('BROWSERSTACK_SESSION', 'Semantic mobile journey'),
      },
    };
  }

  return {
    ...base,
    ...(readEnv('APP_PATH') ? { 'appium:app': readEnv('APP_PATH') } : {}),
    ...(isIos
      ? { 'appium:bundleId': readEnv('APP_BUNDLE_ID') }
      : {
          'appium:appPackage': readEnv('APP_PACKAGE'),
          'appium:appActivity': readEnv('APP_ACTIVITY'),
        }),
    'appium:noReset': readEnv('APPIUM_NO_RESET', 'true').toLowerCase() === 'true',
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
        logLevel: readEnv('APPIUM_LOG_LEVEL', 'warn'),
        capabilities,
      };
  return remote(config);
}

async function ensureDriver() {
  if (!driver) driver = await createDriver();
  return driver;
}

async function currentContext() {
  return String(await driver.getContext().catch(() => 'NATIVE_APP'));
}

async function visibleElements(selector) {
  const elements = await driver.$$(selector).catch(() => []);
  const visible = [];
  for (const element of elements) {
    if (await element.isDisplayed().catch(() => false)) visible.push(element);
  }
  return visible;
}

async function elementInfo(element) {
  const [tag, valueText, label, description, resourceId, enabled] = await Promise.all([
    element.getTagName().catch(() => ''),
    element.getText().catch(() => ''),
    element.getAttribute('label').catch(() => ''),
    element.getAttribute('content-desc').catch(() => ''),
    element.getAttribute('resource-id').catch(() => ''),
    element.isEnabled().catch(() => true),
  ]);
  const display = text(valueText || label || description);
  return { element, tag: text(tag), label: display, resourceId: text(resourceId), enabled: enabled !== false };
}

function isInput(info) {
  return /EditText|TextField|TextView|input|textarea/i.test(info.tag) || /input|message|compose/i.test(info.resourceId);
}

function isControl(info) {
  return /Button|ImageButton|Link|Switch|CheckBox|RadioButton|Cell|button|a$/i.test(info.tag) || Boolean(info.label);
}

async function captureState() {
  await ensureDriver();
  const context = await currentContext();
  const selector = context.includes('WEBVIEW')
    ? 'button, a, input, textarea, [role="button"], [contenteditable="true"], [aria-label]'
    : '//*[@text != "" or @label != "" or @content-desc != "" or self::android.widget.EditText or self::XCUIElementTypeTextField or self::XCUIElementTypeTextView]';
  const raw = await visibleElements(selector);
  const infos = [];
  for (const element of raw.slice(-160)) infos.push(await elementInfo(element));

  latestTargets = new Map();
  const controls = [];
  const inputs = [];
  const messages = [];
  const seen = new Set();

  for (const info of infos) {
    const key = `${info.tag}|${info.label}|${info.resourceId}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (isInput(info)) {
      const id = `input_${inputs.length + 1}`;
      inputs.push({ id, type: 'text', placeholder: info.label, enabled: info.enabled });
      latestTargets.set(id, info);
      continue;
    }

    if (isControl(info) && info.label) {
      const id = `control_${controls.length + 1}`;
      controls.push({ id, type: info.tag || 'control', label: info.label, enabled: info.enabled });
      latestTargets.set(id, info);
    }

    if (info.label) messages.push({ id: `message_${messages.length + 1}`, text: info.label });
  }

  const busy = messages.some(item => /loading|please wait|typing|connecting/i.test(item.text));
  const packageName = await driver.getCurrentPackage().catch(() => '');
  const activity = await driver.getCurrentActivity().catch(() => '');
  const screen = `${packageName}${activity ? `/${activity}` : ''}`;
  const surface = {
    surfaceReady: inputs.length > 0 || controls.length > 0,
    busy,
    messages: messages.slice(-40),
    controls,
    inputs,
    text: messages.map(item => item.text).slice(-120),
    url: screen,
    title: context,
    capturedAt: new Date().toISOString(),
  };

  return {
    chat: surface,
    page: {
      ...surface,
      messages: [],
      url: screen,
      title: context,
    },
    platform: readEnv('MOBILE_PLATFORM', 'android').toLowerCase(),
    context,
  };
}

async function resolveTarget(targetId) {
  const cached = latestTargets.get(targetId);
  if (cached?.element && await cached.element.isDisplayed().catch(() => false)) return cached.element;
  if (!cached) throw new Error(`Unknown runtime target: ${targetId}. Capture state again before executing.`);
  const label = cached.label;
  if (!label) throw new Error(`Runtime target ${targetId} no longer exists.`);
  const literal = xpathLiteral(label);
  const locator = `//*[@text=${literal} or @label=${literal} or @content-desc=${literal}]`;
  const element = await driver.$(locator);
  await element.waitForDisplayed({ timeout: Number(readEnv('MOBILE_ELEMENT_TIMEOUT_MS', '15000')) });
  return element;
}

async function submitInput(input, value) {
  await input.click();
  await input.setValue(value);
  const context = await currentContext();
  const sendCandidates = await visibleElements(context.includes('WEBVIEW')
    ? 'button[type="submit"], button[aria-label*="send" i], [role="button"][aria-label*="send" i]'
    : '//*[@text="Send" or @label="Send" or contains(@content-desc,"Send")]');
  if (sendCandidates[0]) await sendCandidates[0].click();
  else if (context.includes('WEBVIEW')) await driver.keys('Enter');
  else if (readEnv('MOBILE_PLATFORM', 'android').toLowerCase() === 'ios') await driver.keys('\n');
  else await driver.pressKeyCode(66);
}

async function executeRuntimeAction(args) {
  const action = String(args.action || '').toUpperCase();
  if (action === 'WAIT') {
    await driver.pause(Math.max(0, Number(args.waitMs || 1000)));
    return { executed: true, action, scope: args.scope || 'CHAT' };
  }
  if (action === 'BACK') {
    await driver.back();
    return { executed: true, action, scope: args.scope || 'PAGE' };
  }
  const target = await resolveTarget(args.targetId);
  if (action === 'CLICK') await target.click();
  else if (action === 'TYPE') { await target.click(); await target.setValue(String(args.value || '')); }
  else if (action === 'SEND_MESSAGE') await submitInput(target, String(args.value || ''));
  else throw new Error(`Unsupported mobile runtime action: ${action}`);
  return { executed: true, action, targetId: args.targetId, scope: args.scope || 'CHAT' };
}

async function openChatSurface() {
  const state = await captureState();
  if (state.chat.inputs.length) return { opened: true, ready: true, surface: 'existing_chat_input' };

  const configured = text(readEnv('MOBILE_CHAT_TRIGGER_PATTERN', 'chat|help|message|support|assistant'));
  const regex = new RegExp(configured, 'i');
  for (const [id, info] of latestTargets.entries()) {
    if (id.startsWith('control_') && regex.test(info.label)) {
      await info.element.click();
      await driver.pause(Number(readEnv('MOBILE_CHAT_OPEN_WAIT_MS', '1500')));
      const next = await captureState();
      if (next.chat.inputs.length) return { opened: true, ready: true, surface: 'runtime_discovered_trigger' };
    }
  }
  throw new Error('No usable chat input or configurable chat trigger was found on the current mobile screen.');
}

async function screenshot(filename) {
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const filePath = path.join(screenshotsDir, `${safeName(filename, `mobile-${Date.now()}`)}.png`);
  await driver.saveScreenshot(filePath);
  return filePath;
}

async function startVideo() {
  if (recording) return;
  await driver.startRecordingScreen().catch(() => {});
  recording = true;
}

async function stopVideo(filename = `mobile-${Date.now()}.mp4`) {
  if (!recording) return null;
  fs.mkdirSync(videosDir, { recursive: true });
  const data = await driver.stopRecordingScreen().catch(() => '');
  recording = false;
  if (!data) return null;
  const filePath = path.join(videosDir, safeName(filename));
  fs.writeFileSync(filePath, data, 'base64');
  return filePath;
}

const tools = [
  { name: 'pw_navigate', description: 'Initialise the mobile session. URL is ignored for native apps.', inputSchema: { type: 'object', properties: { url: { type: 'string' } } } },
  { name: 'pw_open_olive', description: 'Open the configured generative chat surface using runtime-discovered mobile controls.', inputSchema: { type: 'object', properties: {} } },
  { name: 'pw_capture_runtime_state', description: 'Capture normalised mobile state for the shared semantic runtime.', inputSchema: { type: 'object', properties: {} } },
  { name: 'pw_execute_runtime_action', description: 'Execute a generic runtime action against a captured mobile target.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['CLICK', 'TYPE', 'SEND_MESSAGE', 'WAIT', 'BACK'] }, scope: { type: 'string' }, targetId: { type: 'string' }, value: { type: 'string' }, waitMs: { type: 'number' }, reason: { type: 'string' } }, required: ['action'] } },
  { name: 'pw_finalize_run', description: 'Finalise mobile evidence and close the Appium session.', inputSchema: { type: 'object', properties: {} } },
  { name: 'mobile_start_session', description: 'Initialise the mobile app session.', inputSchema: { type: 'object', properties: {} } },
  { name: 'mobile_click_element', description: 'Legacy click by visible text or accessibility id.', inputSchema: { type: 'object', properties: { target: { type: 'string' }, strategy: { type: 'string', enum: ['text', 'accessibilityId'] } }, required: ['target', 'strategy'] } },
  { name: 'mobile_type_and_enter', description: 'Legacy type and submit into the first visible input.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } },
  { name: 'mobile_read_screen', description: 'Read normalised visible mobile text.', inputSchema: { type: 'object', properties: {} } },
  { name: 'mobile_inspect_dom', description: 'Dump the current Appium page source.', inputSchema: { type: 'object', properties: {} } },
  { name: 'mobile_list_contexts', description: 'List native and webview contexts.', inputSchema: { type: 'object', properties: {} } },
  { name: 'mobile_switch_context', description: 'Switch Appium context.', inputSchema: { type: 'object', properties: { contextName: { type: 'string' } }, required: ['contextName'] } },
  { name: 'mobile_switch_first_webview', description: 'Switch into the first WEBVIEW.', inputSchema: { type: 'object', properties: {} } },
  { name: 'mobile_save_screenshot', description: 'Save a mobile screenshot.', inputSchema: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] } },
  { name: 'mobile_start_video', description: 'Start mobile screen recording.', inputSchema: { type: 'object', properties: {} } },
  { name: 'mobile_stop_and_save_video', description: 'Stop and save mobile recording.', inputSchema: { type: 'object', properties: { filename: { type: 'string' } }, required: ['filename'] } },
];

const server = new Server({ name: 'qa-automation-mobile-semantic-runtime', version: '3.0.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async request => {
  const { name, arguments: args = {} } = request.params;
  try {
    if (name === 'pw_navigate' || name === 'mobile_start_session') {
      await ensureDriver();
      await startVideo();
      return { content: [{ type: 'text', text: name === 'pw_navigate' ? `Navigated to mobile app session` : 'Mobile session started.' }] };
    }
    await ensureDriver();
    let result;
    switch (name) {
      case 'pw_open_olive': result = await openChatSurface(); break;
      case 'pw_capture_runtime_state': result = await captureState(); break;
      case 'pw_execute_runtime_action': result = await executeRuntimeAction(args); break;
      case 'pw_finalize_run': {
        const screenshotPath = await screenshot(`final-mobile-${Date.now()}`);
        const videoPath = await stopVideo();
        await driver.deleteSession().catch(() => {});
        driver = null;
        result = { finalised: true, screenshotFiles: [screenshotPath], videoFiles: videoPath ? [videoPath] : [] };
        break;
      }
      case 'mobile_click_element': {
        const locator = args.strategy === 'accessibilityId' ? `~${args.target}` : `//*[contains(@text, ${xpathLiteral(args.target)}) or contains(@label, ${xpathLiteral(args.target)}) or contains(@content-desc, ${xpathLiteral(args.target)})]`;
        const element = await driver.$(locator); await element.waitForDisplayed({ timeout: 15000 }); await element.click(); result = { executed: true }; break;
      }
      case 'mobile_type_and_enter': {
        const state = await captureState(); const input = state.chat.inputs[0]; if (!input) throw new Error('No visible input found.'); result = await executeRuntimeAction({ action: 'SEND_MESSAGE', targetId: input.id, value: args.text }); break;
      }
      case 'mobile_read_screen': result = (await captureState()).chat.text.join('\n'); break;
      case 'mobile_inspect_dom': result = await driver.getPageSource(); break;
      case 'mobile_list_contexts': result = { contexts: await driver.getContexts() }; break;
      case 'mobile_switch_context': await driver.switchContext(args.contextName); result = { context: args.contextName }; break;
      case 'mobile_switch_first_webview': { const contexts = await driver.getContexts(); const webview = contexts.find(value => String(value).includes('WEBVIEW')); if (!webview) throw new Error(`No WEBVIEW found. Contexts: ${contexts.join(', ')}`); await driver.switchContext(webview); result = { context: webview }; break; }
      case 'mobile_save_screenshot': result = { screenshotPath: await screenshot(args.filename) }; break;
      case 'mobile_start_video': await startVideo(); result = { recording: true }; break;
      case 'mobile_stop_and_save_video': result = { videoPath: await stopVideo(args.filename) }; break;
      default: throw new Error(`Tool not found: ${name}`);
    }
    return { content: [{ type: 'text', text: typeof result === 'string' ? result : JSON.stringify(result) }] };
  } catch (error) {
    return { content: [{ type: 'text', text: JSON.stringify({ error: error.message }) }], isError: true };
  }
});

async function run() { await server.connect(new StdioServerTransport()); }
process.on('exit', () => { if (driver) driver.deleteSession().catch(() => {}); });
run().catch(error => { console.error(error); process.exit(1); });
