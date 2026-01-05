/**
 * Watchman File Watcher
 *
 * Handles Watchman client management, file change detection, and subscriptions.
 */

import { existsSync, realpathSync, writeFileSync } from 'fs';
import { basename, join } from 'path';
import watchman from 'fb-watchman';
import { getClock, setClock } from '../state.js';
import { logger } from '../logger.js';
import { setFlag, clearFlag, getFlagData, FLAGS, WATCHMAN_STATE, ALL_VARIANTS } from '../flags.js';
import { sendSignal } from '../signals.js';
import { getConfig, type Config } from '../config.js';
import { WATCHMAN_SUB_NAME, WATCHMAN_SETTLE_MS } from './constants.js';

// ============================================================================
// Types
// ============================================================================

export interface FileChange {
  name: string; // Relative path from the watch root
  size: number; // File size in bytes
  mtime_ms: number; // Last modification time in milliseconds since epoch
  exists: boolean; // false if the file was deleted
  type: 'f' | 'd'; // 'f' for file, 'd' for directory
  new: boolean; // true if file is newer than the 'since' clock (i.e., newly created)
  watchRoot: string; // Which watch root this change came from (added by us, not from Watchman)
  ino: number; // Inode number - stable across renames/moves within same filesystem
  'content.sha1hex'?: string; // Content hash for files (null/undefined for directories)
}

interface WatchmanQueryResponse {
  clock: string;
  files: Omit<FileChange, 'watchRoot'>[];
}

export type FileChangeHandler = (file: FileChange) => void;
export type FileChangeBatchHandler = (files: FileChange[]) => void;

// ============================================================================
// State
// ============================================================================

/** Track active subscription names for teardown */
let activeSubscriptions: { root: string; subName: string }[] = [];

/** Map subscription name -> configured source path (resolved) for event routing */
const subscriptionToSourcePath: Map<string, string> = new Map();

// ============================================================================
// Watchman Client
// ============================================================================

const watchmanClient = new watchman.Client();

/** Promisified wrapper for Watchman command */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function watchmanCommand<T>(args: any[]): Promise<T> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (watchmanClient as any).command(args, (err: Error | null, resp: T) => {
      if (err) reject(err);
      else resolve(resp);
    });
  });
}

/** Check if watchman is already running without starting it */
function isWatchmanRunning(): boolean {
  const result = Bun.spawnSync(['watchman', 'get-pid', '--no-spawn']);
  return result.exitCode === 0;
}

/** Connect to Watchman and track if we spawned it */
export async function connectWatchman(): Promise<void> {
  const wasRunning = isWatchmanRunning();

  // The client will auto-start watchman if not running
  await watchmanCommand<{ version: string }>(['version']);

  if (!wasRunning) {
    setFlag(FLAGS.WATCHMAN_RUNNING, WATCHMAN_STATE.SPAWNED);
    logger.debug('Watchman was not running, we spawned it');
  } else {
    setFlag(FLAGS.WATCHMAN_RUNNING, WATCHMAN_STATE.EXISTING);
    logger.debug('Watchman was already running');
  }

  // Signal dashboard to refresh (watchman is now ready)
  sendSignal('refresh-dashboard');
}

/** Close the Watchman client connection */
export function closeWatchman(): void {
  watchmanClient.end();
}

/** Shutdown watchman server if we spawned it */
export function shutdownWatchman(): void {
  const watchmanState = getFlagData(FLAGS.WATCHMAN_RUNNING);
  if (watchmanState === WATCHMAN_STATE.SPAWNED) {
    logger.debug('Shutting down watchman server (we spawned it)');
    Bun.spawnSync(['watchman', 'shutdown-server']);
  }
  clearFlag(FLAGS.WATCHMAN_RUNNING, ALL_VARIANTS);
}

// ============================================================================
// Watchman Config
// ============================================================================

/**
 * Ensures a .watchmanconfig file exists in the watch directory with settle configuration.
 * Only creates the file if it doesn't already exist (respects user config).
 */
function ensureWatchmanConfig(watchDir: string): void {
  const configPath = join(watchDir, '.watchmanconfig');

  if (existsSync(configPath)) {
    logger.debug(`[watchman] .watchmanconfig already exists at ${configPath}, skipping`);
    return;
  }

  const config = { settle: WATCHMAN_SETTLE_MS };
  try {
    writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
    logger.info(
      `[watchman] Created .watchmanconfig in ${watchDir} with settle: ${WATCHMAN_SETTLE_MS}ms`
    );
  } catch (err) {
    logger.warn(
      `[watchman] Failed to create .watchmanconfig in ${watchDir}: ${err instanceof Error ? err.message : String(err)}`
    );
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

/** Promisified wrapper for Watchman unsubscribe command */
function unsubscribeWatchman(root: string, subName: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (watchmanClient as any).command(['unsubscribe', root, subName], (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

interface WatchmanQueryOptions {
  savedClock: string | null;
  relative: string;
}

/** Build a Watchman query/subscription object */
function buildWatchmanQuery(options: WatchmanQueryOptions): Record<string, unknown> {
  const { savedClock, relative } = options;

  const query: Record<string, unknown> = {
    expression: ['anyof', ['type', 'f'], ['type', 'd']],
    fields: ['name', 'size', 'mtime_ms', 'exists', 'type', 'new', 'ino', 'content.sha1hex'],
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
// One-shot Query
// ============================================================================

/**
 * Query all configured directories for changes since last sync.
 * Returns all file changes found across all directories.
 */
export async function queryAllChanges(
  config: Config,
  onFileChangeBatch: FileChangeBatchHandler,
  dryRun: boolean
): Promise<number> {
  let totalChanges = 0;

  await Promise.all(
    config.sync_dirs.map(async (dir) => {
      const watchDir = realpathSync(dir.source_path);

      // Register directory with Watchman
      const watchResp = await registerWithWatchman(watchDir);
      const root = watchResp.watch;
      const relative = watchResp.relative_path || '';

      const savedClock = getClock(watchDir);

      if (savedClock) {
        logger.info(`Syncing changes since last run for ${dir.source_path}...`);
      } else {
        logger.info(`First run - syncing all existing files in ${dir.source_path}...`);
      }

      const query = buildWatchmanQuery({ savedClock, relative });
      const resp = await queryWatchman(root, query);

      // Save clock
      if (resp.clock) {
        setClock(watchDir, resp.clock, dryRun);
      }

      // Process changes as a batch
      const files = resp.files || [];
      if (files.length > 0) {
        const fileChanges: FileChange[] = files.map((file) => ({
          ...file,
          watchRoot: watchDir,
        }));
        onFileChangeBatch(fileChanges);
        totalChanges += files.length;
      }
    })
  );

  return totalChanges;
}

// ============================================================================
// Watch Mode (Subscriptions)
// ============================================================================

/**
 * Set up Watchman subscriptions for all configured directories.
 * Calls onFileChangeBatch for each batch of file changes detected.
 */
export async function setupWatchSubscriptions(
  config: Config,
  onFileChangeBatch: FileChangeBatchHandler,
  dryRun: boolean
): Promise<void> {
  // Clear any existing subscriptions first
  await teardownWatchSubscriptions();

  // Register event listener BEFORE creating subscriptions to avoid missing events
  watchmanClient.on('subscription', (resp: watchman.SubscriptionResponse) => {
    // Check if this is one of our subscriptions
    if (!resp.subscription.startsWith(WATCHMAN_SUB_NAME)) return;

    // Log subscription event summary and full data for debugging
    const fileCount = resp.files?.length ?? 0;
    const isFresh = (resp as unknown as { is_fresh_instance?: boolean }).is_fresh_instance;
    logger.debug(
      `[watchman] subscription event: ${resp.subscription} (files: ${fileCount}, fresh: ${isFresh ?? false})`
    );
    logger.debug(`[watchman] subscription payload:\n${JSON.stringify(resp, null, 2)}`);

    // Look up the configured source path from the subscription name
    // This handles cases where Watchman's watch root differs from configured path
    // (e.g., watching /Users/foo/Documents/lotsofstuff but Watchman returns root=/Users/foo/Documents)
    const resolvedRoot = subscriptionToSourcePath.get(resp.subscription);

    if (!resolvedRoot) {
      logger.warn(`Ignoring event for unknown subscription: ${resp.subscription}`);
      return;
    }

    // Verify the sync dir still exists in config (may have been removed)
    const currentConfig = getConfig();
    const syncDir = currentConfig.sync_dirs.find(
      (d) => realpathSync(d.source_path) === resolvedRoot
    );

    if (!syncDir) {
      // This can happen legitimately during config transitions
      logger.warn(
        `Ignoring event for removed sync dir: ${resolvedRoot} (subscription: ${resp.subscription})`
      );
      return;
    }

    // Process files as a batch
    const fileChanges: FileChange[] = resp.files.map((file) => {
      const fileChange = file as unknown as Omit<FileChange, 'watchRoot'>;
      return { ...fileChange, watchRoot: resolvedRoot };
    });

    if (fileChanges.length > 0) {
      onFileChangeBatch(fileChanges);
    }

    // Save the new clock so we don't see these events again on restart
    const clock = (resp as unknown as { clock?: string }).clock;
    if (clock) {
      setClock(resolvedRoot, clock, dryRun);
    }
  });

  // Handle errors
  watchmanClient.on('error', (e: Error) => logger.error(`Watchman error: ${e}`));
  watchmanClient.on('end', () => {});

  // Set up watches for all configured directories
  await Promise.all(
    config.sync_dirs.map(async (dir) => {
      const watchDir = realpathSync(dir.source_path);
      const subName = `${WATCHMAN_SUB_NAME}-${basename(watchDir)}`;

      // Ensure .watchmanconfig exists with settle configuration before registering watch
      ensureWatchmanConfig(watchDir);

      // Register directory with Watchman
      const watchResp = await registerWithWatchman(watchDir);
      const root = watchResp.watch;
      const relative = watchResp.relative_path || '';

      logger.debug(
        `[watchman] watch-project response for ${watchDir}: root=${root}, relative_path="${relative}"`
      );

      // Use saved clock for this directory or null for initial sync
      const savedClock = getClock(watchDir);

      if (savedClock) {
        logger.info(`Resuming ${dir.source_path} from last sync state...`);
      } else {
        logger.info(`First run - syncing all existing files in ${dir.source_path}...`);
      }

      // TODO: Re-enable settle parameters after debugging
      const sub = buildWatchmanQuery({
        savedClock,
        relative,
      });

      // Register subscription and store mapping for event routing
      await subscribeWatchman(root, subName, sub);
      activeSubscriptions.push({ root, subName });
      subscriptionToSourcePath.set(subName, watchDir);
      logger.info(`Watching ${dir.source_path} for changes...`);
    })
  );

  logger.info('Watching for file changes... (press Ctrl+C to exit)');
}

/**
 * Tear down all active Watchman subscriptions.
 * Call this before re-setting up subscriptions on config change.
 */
export async function teardownWatchSubscriptions(): Promise<void> {
  if (activeSubscriptions.length === 0) return;

  logger.info('Tearing down watch subscriptions...');

  // Remove subscription event listeners
  watchmanClient.removeAllListeners('subscription');

  // Unsubscribe from all active subscriptions
  await Promise.all(
    activeSubscriptions.map(async ({ root, subName }) => {
      try {
        await unsubscribeWatchman(root, subName);
        logger.debug(`Unsubscribed from ${subName}`);
      } catch (err) {
        logger.warn(`Failed to unsubscribe from ${subName}: ${(err as Error).message}`);
      }
    })
  );

  activeSubscriptions = [];
  subscriptionToSourcePath.clear();
}
