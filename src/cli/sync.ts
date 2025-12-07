/**
 * Sync Command - Watch and sync files to Proton Drive
 */

import { realpathSync } from 'fs';
import { basename } from 'path';
import { execSync } from 'child_process';
import watchman from 'fb-watchman';
import { getClock, setClock } from '../state.js';
import { loadConfig, type Config } from '../config.js';
import { logger, enableVerbose } from '../logger.js';
import { authenticateFromKeychain } from './auth.js';
import { hasSignal, consumeSignal, isAlreadyRunning } from '../signals.js';
import { enqueueJob, processAllPendingJobs } from '../jobs.js';
import { SyncEventType } from '../db/schema.js';
import type { ProtonDriveClient } from '../types.js';

// ============================================================================
// Types
// ============================================================================

interface FileChange {
  name: string;
  size: number;
  mtime_ms: number;
  exists: boolean;
  type: 'f' | 'd';
  watchRoot: string; // Which watch root this change came from
  clock?: string; // The clock value to save after processing this change (daemon mode)
}

interface WatchmanQueryResponse {
  clock: string;
  files: Omit<FileChange, 'watchRoot' | 'clock'>[];
}

// ============================================================================
// Constants
// ============================================================================

const SUB_NAME = 'proton-drive-sync';

// Debounce time in ms - wait for rapid changes to settle
const DEBOUNCE_MS = 500;

// ============================================================================
// Options & State
// ============================================================================

let dryRun = false;
let watchMode = false;
let remoteRoot = '';

// Queue of pending changes (path -> latest change info)
const pendingChanges = new Map<string, FileChange>();
let debounceTimer: NodeJS.Timeout | null = null;
let protonClient: ProtonDriveClient | null = null;
let isProcessing = false;

// ============================================================================
// Watchman Client
// ============================================================================

const watchmanClient = new watchman.Client();

/** Wait for Watchman to be available, retrying with delay */
async function waitForWatchman(maxAttempts = 30, delayMs = 1000): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      execSync('watchman version', { stdio: 'ignore' });
      return;
    } catch {
      if (attempt === maxAttempts) {
        console.error('Error: Watchman failed to start.');
        console.error('Install it from: https://facebook.github.io/watchman/docs/install');
        process.exit(1);
      }
      logger.debug(`Waiting for watchman to start (attempt ${attempt}/${maxAttempts})...`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// ============================================================================
// Change Queue & Processing
// ============================================================================

async function processChanges(): Promise<void> {
  if (isProcessing || !protonClient) return;
  isProcessing = true;

  // Take snapshot of current pending changes
  const changes = new Map(pendingChanges);
  pendingChanges.clear();

  // Process all changes
  for (const [path, change] of changes) {
    // Build local path (where to read from)
    const localPath = `${change.watchRoot}/${path}`;
    // Build remote path (where to upload to on Proton Drive)
    const dirName = basename(change.watchRoot);
    const remotePath = remoteRoot ? `${remoteRoot}/${dirName}/${path}` : `${dirName}/${path}`;

    // Determine event type
    let eventType: SyncEventType;
    if (!change.exists) {
      eventType = SyncEventType.DELETE;
    } else if (change.type === 'd') {
      eventType = SyncEventType.CREATE;
    } else {
      // For files, we treat both create and modify as UPDATE
      // (createNode handles both cases)
      eventType = SyncEventType.UPDATE;
    }

    const typeLabel = change.type === 'd' ? 'directory' : 'file';

    logger.debug(`Enqueueing ${eventType} job for ${typeLabel}: ${path}`);

    enqueueJob(
      {
        eventType,
        localPath,
        remotePath,
      },
      dryRun
    );
  }

  // Process all pending jobs from the queue
  const processed = await processAllPendingJobs(protonClient, dryRun);
  if (processed > 0) {
    logger.info(`Processed ${processed} sync job(s)`);
  }

  isProcessing = false;

  // If more changes came in while processing, schedule another run
  if (pendingChanges.size > 0) {
    scheduleProcessing();
  }
}

/**
 * Debounce file change processing.
 *
 * When multiple file changes arrive in quick succession (e.g., editor saving
 * multiple files, or a bulk copy operation), this ensures we only process
 * once after the activity settles. Each call resets the timer, so
 * processChanges() only fires after DEBOUNCE_MS of inactivity.
 */
function scheduleProcessing(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    processChanges();
  }, DEBOUNCE_MS);
}

function queueChange(file: FileChange, schedule: boolean): void {
  const status = file.exists ? (file.type === 'd' ? 'dir changed' : 'changed') : 'deleted';
  const typeLabel = file.type === 'd' ? 'dir' : 'file';
  logger.debug(`[${status}] ${file.name} (size: ${file.size ?? 0}, type: ${typeLabel})`);

  pendingChanges.set(file.name, file);
  if (schedule) {
    scheduleProcessing();
  }
}

// ============================================================================
// Watchman Helpers (promisified)
// ============================================================================

/** Promisified wrapper for Watchman watch-project command */
function registerWithWatchman(dir: string): Promise<watchman.WatchProjectResponse> {
  return new Promise((resolve, reject) => {
    watchmanClient.command(['watch-project', dir], (err, resp) => {
      if (err) reject(err);
      else resolve(resp as watchman.WatchProjectResponse);
    });
  });
}

/** Promisified wrapper for Watchman query command */
function queryWatchman(
  root: string,
  query: Record<string, unknown>
): Promise<WatchmanQueryResponse> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (watchmanClient as any).command(
      ['query', root, query],
      (err: Error | null, resp: WatchmanQueryResponse) => {
        if (err) reject(err);
        else resolve(resp);
      }
    );
  });
}

/** Promisified wrapper for Watchman subscribe command */
function subscribeWatchman(
  root: string,
  subName: string,
  sub: Record<string, unknown>
): Promise<void> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (watchmanClient as any).command(['subscribe', root, subName, sub], (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/** Build a Watchman query/subscription object */
function buildWatchmanQuery(savedClock: string | null, relative: string): Record<string, unknown> {
  const query: Record<string, unknown> = {
    expression: ['anyof', ['type', 'f'], ['type', 'd']],
    fields: ['name', 'size', 'mtime_ms', 'exists', 'type'],
  };

  if (savedClock) {
    query.since = savedClock;
  }

  if (relative) {
    query.relative_root = relative;
  }

  return query;
}

// ============================================================================
// One-shot Sync (query mode)
// ============================================================================

/**
 * Run a one-shot sync for all configured directories.
 * Uses Promise.all to query all directories concurrently, then processes changes.
 */
async function runOneShotSync(config: Config): Promise<void> {
  // Query all directories concurrently
  await Promise.all(
    config.sync_dirs.map(async (dir) => {
      const watchDir = realpathSync(dir);

      // Register directory with Watchman
      const watchResp = await registerWithWatchman(watchDir);
      // Watchman may watch a parent dir; root is the actual watch, relative is our target within it
      const root = watchResp.watch;
      const relative = watchResp.relative_path || '';

      const savedClock = getClock(watchDir);

      if (savedClock) {
        logger.info(`Syncing changes since last run for ${dir}...`);
      } else {
        logger.info(`First run - syncing all existing files in ${dir}...`);
      }

      const query = buildWatchmanQuery(savedClock, relative);
      const resp = await queryWatchman(root, query);

      // Save clock
      if (resp.clock) {
        setClock(watchDir, resp.clock, dryRun);
      }

      // Queue changes (don't schedule processing - we'll call processChanges directly after)
      const files = resp.files || [];
      for (const file of files) {
        const fileChange = file as Omit<FileChange, 'watchRoot'>;
        queueChange({ ...fileChange, watchRoot: watchDir }, false);
      }
    })
  );

  // Process all queued changes
  if (pendingChanges.size === 0) {
    logger.info('No changes to sync.');
    return;
  }

  await processChanges();
}

// ============================================================================
// Daemon Mode (subscription mode)
// ============================================================================

async function setupWatchmanDaemon(config: Config): Promise<void> {
  // Set up watches for all configured directories
  await Promise.all(
    config.sync_dirs.map(async (dir) => {
      const watchDir = realpathSync(dir);
      const subName = `${SUB_NAME}-${basename(watchDir)}`;

      // Register directory with Watchman
      const watchResp = await registerWithWatchman(watchDir);
      // Watchman may watch a parent dir; root is the actual watch, relative is our target within it
      const root = watchResp.watch;
      const relative = watchResp.relative_path || '';

      // Use saved clock for this directory or null for initial sync
      const savedClock = getClock(watchDir);

      if (savedClock) {
        logger.info(`Resuming ${dir} from last sync state...`);
      } else {
        logger.info(`First run - syncing all existing files in ${dir}...`);
      }

      const sub = buildWatchmanQuery(savedClock, relative);

      // Register subscription
      await subscribeWatchman(root, subName, sub);
      logger.info(`Watching ${dir} for changes...`);
    })
  );

  // Listen for notifications from all subscriptions
  watchmanClient.on('subscription', (resp: watchman.SubscriptionResponse) => {
    // Check if this is one of our subscriptions
    if (!resp.subscription.startsWith(SUB_NAME)) return;

    // Extract the watch root from the subscription name
    const dirName = resp.subscription.replace(`${SUB_NAME}-`, '');
    const watchRoot = config.sync_dirs.find((d) => basename(realpathSync(d)) === dirName) || '';

    if (!watchRoot) {
      logger.error(`Could not find watch root for subscription: ${resp.subscription}`);
      return;
    }

    const resolvedRoot = realpathSync(watchRoot);

    // Get clock from this notification (will be saved after each file is processed)
    const clock = (resp as unknown as { clock?: string }).clock;

    for (const file of resp.files) {
      const fileChange = file as unknown as Omit<FileChange, 'watchRoot' | 'clock'>;
      queueChange({ ...fileChange, watchRoot: resolvedRoot, clock }, true);
    }
  });

  // Handle errors & shutdown
  watchmanClient.on('error', (e: Error) => logger.error(`Watchman error: ${e}`));
  watchmanClient.on('end', () => {});

  logger.info('Watching for file changes... (press Ctrl+C to exit)');
}

// ============================================================================
// Command
// ============================================================================

export async function startCommand(options: {
  verbose: boolean;
  dryRun: boolean;
  watch: boolean;
  daemon: boolean;
}): Promise<void> {
  // Validate: --daemon requires --watch
  if (options.daemon && !options.watch) {
    console.error('Error: --daemon (-d) requires --watch (-w)');
    process.exit(1);
  }

  // Wait for watchman to be ready
  await waitForWatchman();

  // Check if another proton-drive-sync instance is already running
  if (isAlreadyRunning(true)) {
    console.error(
      'Error: Another proton-drive-sync instance is already running. Run `proton-drive-sync stop` first.'
    );
    process.exit(1);
  }

  if (options.verbose || options.dryRun) {
    enableVerbose();
  }

  if (options.dryRun) {
    dryRun = true;
    logger.info('[DRY-RUN] Dry run mode enabled - no changes will be made');
  }

  watchMode = options.watch;

  // Load config
  const config = loadConfig();

  // Set remote root from config
  remoteRoot = config.remote_root;

  // Authenticate using stored credentials
  protonClient = await authenticateFromKeychain();

  if (watchMode) {
    // Watch mode: use subscriptions and keep running
    setupWatchmanDaemon(config);

    // Check for stop signal every second
    const stopSignalCheck = setInterval(() => {
      if (hasSignal('stop')) {
        consumeSignal('stop');
        logger.info('Stop signal received. Shutting down...');
        clearInterval(stopSignalCheck);
        watchmanClient.end();
        process.exit(0);
      }
    }, 1000);

    // Handle graceful shutdown
    process.on('SIGINT', () => {
      clearInterval(stopSignalCheck);
      logger.info('Shutting down...');
      watchmanClient.end();
      process.exit(0);
    });
  } else {
    // One-shot mode: query for changes, process, and exit
    await runOneShotSync(config);
    watchmanClient.end();
  }
}
