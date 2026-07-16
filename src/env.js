'use strict';

const fs = require('fs');
const path = require('path');

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  return fs.readFileSync(filePath, 'utf8')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line =>
      line &&
      !line.startsWith('#') &&
      line.includes('=')
    )
    .reduce((result, line) => {
      const separatorIndex = line.indexOf('=');
      const key = line.slice(0, separatorIndex).trim();

      let value = line
        .slice(separatorIndex + 1)
        .trim();

      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      result[key] = value;
      return result;
    }, {});
}

function loadProjectEnv(...fileNames) {
  /*
   * Component-specific files are loaded first.
   * The root .env is then used as a common fallback.
   * Shell variables always have the highest priority.
   */
  const files = [
    ...new Set([
      ...fileNames,
      '.env',
    ]),
  ];

  for (const fileName of files) {
    const filePath = path.resolve(
      __dirname,
      '..',
      fileName
    );

    const values = parseEnvFile(filePath);

    for (const [key, value] of Object.entries(values)) {
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

function readEnv(key, fallback = undefined) {
  const value = process.env[key];

  return value === undefined || value === ''
    ? fallback
    : value;
}

function requireEnv(key, hint) {
  const value = readEnv(key);

  if (!value) {
    throw new Error(
      `Missing required environment variable ${key}` +
      `${hint ? `. ${hint}` : ''}`
    );
  }

  return value;
}

module.exports = {
  parseEnvFile,
  loadProjectEnv,
  readEnv,
  requireEnv,
};
