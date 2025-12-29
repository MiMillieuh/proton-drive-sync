/**
 * Config Command - Open dashboard settings page
 */

import { isAlreadyRunning } from '../flags.js';
import { startDashboard } from '../dashboard/server.js';
import { loadConfig } from '../config.js';
import { logger } from '../logger.js';

const SETTINGS_URL = 'http://localhost:4242/controls';

export function configCommand(): void {
  if (isAlreadyRunning()) {
    logger.info(`Dashboard is already running. Open settings at:\n\n  ${SETTINGS_URL}\n`);
    return;
  }

  // Start just the dashboard (not the sync client)
  const config = loadConfig();
  startDashboard(config);
  logger.info(`Dashboard started. Open settings at:\n\n  ${SETTINGS_URL}\n`);

  // Keep process alive
  process.on('SIGINT', () => {
    logger.info('Stopping dashboard...');
    process.exit(0);
  });
}
