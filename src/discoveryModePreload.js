'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const projectRoot = process.cwd();
const generatedSpecsRoot = path.resolve(projectRoot, 'generated-specs');

const guardLogPath =
  process.env.DISCOVERY_GUARD_LOG ||
  path.resolve(
    projectRoot,
    'reports',
    'discovery',
    'discovery-guard.jsonl'
  );

const blockedToolNames = new Set([
  'save_spec_file',
  'generate_spec',
  'create_spec',
  'write_spec',
  'update_spec',
  'save_generated_spec',
]);

process.env.AGENT_RUN_MODE = 'discover';
process.env.AUTO_SAVE_SPEC = 'false';
process.env.AUTO_RUN_GENERATED_SPEC = 'false';
process.env.DISABLE_SPEC_GENERATION = 'true';

function ensureParent(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

const originalAppendFileSync = fs.appendFileSync.bind(fs);

function logEvent(event) {
  try {
    ensureParent(guardLogPath);

    originalAppendFileSync(
      guardLogPath,
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        ...event,
      })}\n`,
      'utf8'
    );
  } catch {
    // Guard logging must never stop discovery.
  }
}

function normalisePath(filePath) {
  if (Buffer.isBuffer(filePath)) {
    return filePath.toString('utf8');
  }

  return typeof filePath === 'string' ? filePath : null;
}

function isGeneratedSpecPath(filePath) {
  const normalised = normalisePath(filePath);

  if (!normalised) {
    return false;
  }

  const resolved = path.resolve(normalised);

  return (
    resolved === generatedSpecsRoot ||
    resolved.startsWith(`${generatedSpecsRoot}${path.sep}`)
  );
}

function blockedWriteError(filePath) {
  const error = new Error(
    `Discovery mode blocked a generated-spec write: ${String(filePath)}`
  );

  error.code = 'DISCOVERY_SPEC_WRITE_BLOCKED';

  logEvent({
    type: 'blocked_write',
    filePath: String(filePath),
    message: error.message,
  });

  return error;
}

/*
 * Block direct writes into generated-specs.
 */
const originalWriteFileSync = fs.writeFileSync.bind(fs);
const originalWriteFile = fs.writeFile.bind(fs);
const originalCreateWriteStream = fs.createWriteStream.bind(fs);
const originalCopyFileSync = fs.copyFileSync.bind(fs);
const originalRenameSync = fs.renameSync.bind(fs);

fs.writeFileSync = function guardedWriteFileSync(filePath, ...args) {
  if (isGeneratedSpecPath(filePath)) {
    throw blockedWriteError(filePath);
  }

  return originalWriteFileSync(filePath, ...args);
};

fs.writeFile = function guardedWriteFile(filePath, ...args) {
  if (!isGeneratedSpecPath(filePath)) {
    return originalWriteFile(filePath, ...args);
  }

  const error = blockedWriteError(filePath);

  const callback = [...args]
    .reverse()
    .find(value => typeof value === 'function');

  if (callback) {
    process.nextTick(() => callback(error));
    return;
  }

  throw error;
};

fs.createWriteStream = function guardedCreateWriteStream(filePath, ...args) {
  if (isGeneratedSpecPath(filePath)) {
    throw blockedWriteError(filePath);
  }

  return originalCreateWriteStream(filePath, ...args);
};

fs.copyFileSync = function guardedCopyFileSync(
  source,
  destination,
  ...args
) {
  if (isGeneratedSpecPath(destination)) {
    throw blockedWriteError(destination);
  }

  return originalCopyFileSync(source, destination, ...args);
};

fs.renameSync = function guardedRenameSync(
  source,
  destination,
  ...args
) {
  if (isGeneratedSpecPath(destination)) {
    throw blockedWriteError(destination);
  }

  return originalRenameSync(source, destination, ...args);
};

try {
  const originalPromisesWriteFile =
    fs.promises.writeFile.bind(fs.promises);

  fs.promises.writeFile = async function guardedPromisesWriteFile(
    filePath,
    ...args
  ) {
    if (isGeneratedSpecPath(filePath)) {
      throw blockedWriteError(filePath);
    }

    return originalPromisesWriteFile(filePath, ...args);
  };
} catch {
  // Ignore if the method cannot be patched.
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

/*
 * Remove spec-generation declarations from Gemini tool lists.
 */
function stripBlockedTools(value, removedTools) {
  if (Array.isArray(value)) {
    return value
      .map(item => stripBlockedTools(item, removedTools))
      .filter(item => item !== undefined);
  }

  if (!isPlainObject(value)) {
    return value;
  }

  const declaredName =
    typeof value.name === 'string'
      ? value.name.trim()
      : '';

  if (blockedToolNames.has(declaredName)) {
    removedTools.push(declaredName);
    return undefined;
  }

  const result = {};

  for (const [key, child] of Object.entries(value)) {
    const cleaned = stripBlockedTools(child, removedTools);

    if (cleaned !== undefined) {
      result[key] = cleaned;
    }
  }

  return result;
}

function patchModels(models) {
  if (!models) {
    return;
  }

  for (const methodName of [
    'generateContent',
    'generateContentStream',
  ]) {
    if (typeof models[methodName] !== 'function') {
      continue;
    }

    const originalMethod = models[methodName].bind(models);

    models[methodName] = function guardedGenerateContent(request) {
      const removedTools = [];

      const cleanedRequest = stripBlockedTools(
        request,
        removedTools
      );

      if (removedTools.length > 0) {
        logEvent({
          type: 'stripped_tool_declarations',
          methodName,
          tools: [...new Set(removedTools)],
        });
      }

      return originalMethod(cleanedRequest);
    };
  }
}

function patchGeminiClient(client) {
  if (!client || client.__discoveryGuardInstalled) {
    return client;
  }

  patchModels(client.models);

  Object.defineProperty(
    client,
    '__discoveryGuardInstalled',
    {
      value: true,
      enumerable: false,
    }
  );

  return client;
}

/*
 * Intercept @google/genai before the runtime imports it.
 */
const originalModuleLoad = Module._load;

Module._load = function guardedModuleLoad(
  request,
  parent,
  isMain
) {
  const loaded = originalModuleLoad.call(
    this,
    request,
    parent,
    isMain
  );

  if (
    request !== '@google/genai' ||
    !loaded ||
    typeof loaded.GoogleGenAI !== 'function'
  ) {
    return loaded;
  }

  if (loaded.__discoveryWrappedModule) {
    return loaded;
  }

  const OriginalGoogleGenAI = loaded.GoogleGenAI;

  class DiscoveryGoogleGenAI extends OriginalGoogleGenAI {
    constructor(...args) {
      super(...args);
      patchGeminiClient(this);
    }
  }

  return {
    ...loaded,
    GoogleGenAI: DiscoveryGoogleGenAI,
    __discoveryWrappedModule: true,
  };
};

logEvent({
  type: 'guard_started',
  mode: 'discover',
  generatedSpecsRoot,
});
