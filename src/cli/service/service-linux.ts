/**
 * Linux systemd user service implementation
 */

import { existsSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { setFlag, clearFlag, FLAGS } from '../../flags.js';
import { logger } from '../../logger.js';
import type { ServiceOperations } from './types.js';
// @ts-expect-error Bun text imports
import serviceTemplate from './templates/proton-drive-sync.service' with { type: 'text' };

const SYSTEMD_USER_DIR = join(homedir(), '.config', 'systemd', 'user');
const SERVICE_NAME = 'proton-drive-sync';
const SERVICE_PATH = join(SYSTEMD_USER_DIR, `${SERVICE_NAME}.service`);

function generateServiceFile(binPath: string): string {
  const home = homedir();
  return serviceTemplate.replace('{{BIN_PATH}}', binPath).replace(/\{\{HOME\}\}/g, home);
}

function runSystemctl(...args: string[]): { success: boolean; error?: string } {
  const result = Bun.spawnSync(['systemctl', '--user', ...args]);
  if (result.exitCode === 0) {
    return { success: true };
  }
  const stderr = new TextDecoder().decode(result.stderr).trim();
  return { success: false, error: stderr || `exit code ${result.exitCode}` };
}

function daemonReload(): boolean {
  const result = runSystemctl('daemon-reload');
  return result.success;
}

export const linuxService: ServiceOperations = {
  async install(binPath: string): Promise<boolean> {
    // Create systemd user directory if it doesn't exist
    if (!existsSync(SYSTEMD_USER_DIR)) {
      mkdirSync(SYSTEMD_USER_DIR, { recursive: true });
    }

    logger.info('Installing proton-drive-sync service...');

    // If service exists, stop and disable it first
    if (existsSync(SERVICE_PATH)) {
      runSystemctl('stop', SERVICE_NAME);
      runSystemctl('disable', SERVICE_NAME);
    }

    // Write service file
    await Bun.write(SERVICE_PATH, generateServiceFile(binPath));
    logger.info(`Created: ${SERVICE_PATH}`);

    // Reload systemd to pick up new service
    if (!daemonReload()) {
      logger.error('Failed to reload systemd daemon');
      return false;
    }

    setFlag(FLAGS.SERVICE_INSTALLED);

    if (this.load()) {
      logger.info('proton-drive-sync service installed and started.');
      return true;
    } else {
      logger.error('proton-drive-sync service installed but failed to start.');
      return false;
    }
  },

  async uninstall(interactive: boolean): Promise<boolean> {
    if (!existsSync(SERVICE_PATH)) {
      if (interactive) {
        logger.info('No service is installed.');
      }
      return true;
    }

    logger.info('Uninstalling proton-drive-sync service...');

    // Stop and disable the service
    if (!this.unload()) {
      logger.warn('Failed to unload service, continuing with uninstall...');
    }

    // Remove service file
    unlinkSync(SERVICE_PATH);
    daemonReload();

    clearFlag(FLAGS.SERVICE_INSTALLED);
    logger.info('proton-drive-sync service uninstalled.');
    return true;
  },

  load(): boolean {
    if (!existsSync(SERVICE_PATH)) {
      return false;
    }

    // Enable and start the service
    const enableResult = runSystemctl('enable', SERVICE_NAME);
    if (!enableResult.success) {
      logger.error(`Failed to enable service: ${enableResult.error}`);
      return false;
    }

    const startResult = runSystemctl('start', SERVICE_NAME);
    if (!startResult.success) {
      logger.error(`Failed to start service: ${startResult.error}`);
      return false;
    }

    setFlag(FLAGS.SERVICE_LOADED);
    logger.info('Service loaded: will start on login');
    return true;
  },

  unload(): boolean {
    if (!existsSync(SERVICE_PATH)) {
      clearFlag(FLAGS.SERVICE_LOADED);
      return true;
    }

    // Stop the service
    const stopResult = runSystemctl('stop', SERVICE_NAME);
    if (!stopResult.success) {
      // Service might not be running, that's OK
      logger.debug(`Stop result: ${stopResult.error}`);
    }

    // Disable the service
    const disableResult = runSystemctl('disable', SERVICE_NAME);
    if (!disableResult.success) {
      logger.error(`Failed to disable service: ${disableResult.error}`);
      return false;
    }

    clearFlag(FLAGS.SERVICE_LOADED);
    logger.info('Service unloaded: will not start on login');
    return true;
  },

  isInstalled(): boolean {
    return existsSync(SERVICE_PATH);
  },

  getServicePath(): string {
    return SERVICE_PATH;
  },
};
