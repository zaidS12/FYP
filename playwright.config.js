'use strict';
// Playwright e2e. Starts the real server on port 3100 against a THROWAWAY data directory (never data/db.json).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defineConfig, devices } = require('@playwright/test');

const PORT = 3100;
const dataDir = process.env.AF_E2E_DATA || fs.mkdtempSync(path.join(os.tmpdir(), 'af e2e '));
process.env.AF_E2E_DATA = dataDir;

module.exports = defineConfig({
  testDir: path.join(__dirname, 'tests', 'e2e'),
  workers: 1,
  fullyParallel: false,
  retries: 0,
  timeout: 30000,
  reporter: [['list']],
  use: { baseURL: `http://127.0.0.1:${PORT}`, ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure' },
  webServer: {
    command: 'node server.js',
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 20000,
    env: { PORT: String(PORT), DATA_DIR: dataDir, TRUST_PROXY: '1' },
  },
});
