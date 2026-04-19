import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

const CONFIG_MODULE_PATH = pathToFileURL(path.resolve(process.cwd(), 'server/services/editor/config.js')).href;

test('loadConfig caches file reads until cache is invalidated', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'autoedit-config-'));
  const configFile = path.join(tempDir, 'config.json');
  const previousConfigFile = process.env.AUTOEDIT_CONFIG_FILE;

  try {
    await fs.writeFile(configFile, JSON.stringify({ auth_secret: 'alpha', workspace_dir: '/tmp/a' }), 'utf8');
    process.env.AUTOEDIT_CONFIG_FILE = configFile;

    const configModule = await import(`${CONFIG_MODULE_PATH}?t=${Date.now()}`);
    const first = configModule.loadConfig();
    assert.equal(first.auth_secret, 'alpha');
    assert.equal(first.workspace_dir, '/tmp/a');

    await fs.writeFile(configFile, JSON.stringify({ auth_secret: 'beta', workspace_dir: '/tmp/b' }), 'utf8');

    const second = configModule.loadConfig();
    assert.equal(second.auth_secret, 'alpha');
    assert.equal(second.workspace_dir, '/tmp/a');

    configModule.invalidateConfigCache();
    const third = configModule.loadConfig();
    assert.equal(third.auth_secret, 'beta');
    assert.equal(third.workspace_dir, '/tmp/b');
  } finally {
    if (previousConfigFile === undefined) {
      delete process.env.AUTOEDIT_CONFIG_FILE;
    } else {
      process.env.AUTOEDIT_CONFIG_FILE = previousConfigFile;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  }
});
