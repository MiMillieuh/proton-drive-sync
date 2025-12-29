/**
 * Resume Command
 *
 * Resumes the syncing loop after it has been paused.
 */

import { sendSignal } from '../signals.js';
import { isAlreadyRunning, isPaused } from '../flags.js';
import { logger } from '../logger.js';

/**
 * Resume the sync process by sending a resume signal.
 * The process will start processing sync jobs again.
 */
export function resumeCommand(): void {
  // Check if a sync process is running first
  if (!isAlreadyRunning()) {
    logger.info('No running proton-drive-sync process found.');
    return;
  }

  // Check if actually paused
  if (!isPaused()) {
    logger.info('Sync is not paused.');
    return;
  }

  // Send resume signal to the process
  sendSignal('resume-sync');
  logger.info('Resume signal sent. Waiting for confirmation...');

  // Wait for up to 5 seconds for the paused flag to be cleared
  const startTime = Date.now();
  const timeout = 5000;
  const checkInterval = 100;

  const waitForAck = (): void => {
    // Flag cleared = process acknowledged
    if (!isPaused()) {
      logger.info('Syncing resumed.');
      return;
    }

    if (Date.now() - startTime < timeout) {
      setTimeout(waitForAck, checkInterval);
    } else {
      logger.info('Process did not respond to resume signal.');
    }
  };

  waitForAck();
}
