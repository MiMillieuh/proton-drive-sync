/**
 * Proton Drive Sync - Job Queue
 *
 * Manages the sync job queue for buffered file operations.
 */

import { eq, and, lte } from 'drizzle-orm';
import { db, schema } from './db/index.js';
import { SyncJobStatus, SyncEventType } from './db/schema.js';
import { createNode } from './create.js';
import { deleteNode } from './delete.js';
import { logger } from './logger.js';
import type { ProtonDriveClient } from './types.js';

// ============================================================================
// Constants
// ============================================================================

const MAX_RETRIES = 10;
const BASE_RETRY_DELAY_MS = 1000; // 1 second
const MAX_RETRY_DELAY_MS = 5 * 60 * 1000; // 5 minutes

// ============================================================================
// Job Queue Functions
// ============================================================================

/**
 * Add a sync job to the queue.
 * No-op if dryRun is true.
 */
export function enqueueJob(
  params: {
    eventType: SyncEventType;
    localPath: string;
    remotePath: string;
  },
  dryRun: boolean
): void {
  if (dryRun) return;
  db.insert(schema.syncJobs)
    .values({
      eventType: params.eventType,
      localPath: params.localPath,
      remotePath: params.remotePath,
      status: SyncJobStatus.PENDING,
      retryAt: new Date(),
      nRetries: 0,
      lastError: null,
    })
    .run();
}

/**
 * Get the next pending job that's ready to be processed.
 */
export function getNextPendingJob() {
  return db
    .select()
    .from(schema.syncJobs)
    .where(
      and(
        eq(schema.syncJobs.status, SyncJobStatus.PENDING),
        lte(schema.syncJobs.retryAt, new Date())
      )
    )
    .orderBy(schema.syncJobs.retryAt)
    .limit(1)
    .get();
}

/**
 * Mark a job as synced (completed successfully).
 * No-op if dryRun is true.
 */
export function markJobSynced(jobId: number, dryRun: boolean): void {
  if (dryRun) return;
  db.update(schema.syncJobs)
    .set({ status: SyncJobStatus.SYNCED, lastError: null })
    .where(eq(schema.syncJobs.id, jobId))
    .run();
}

/**
 * Mark a job as blocked (failed permanently after max retries).
 * No-op if dryRun is true.
 */
export function markJobBlocked(jobId: number, error: string, dryRun: boolean): void {
  if (dryRun) return;
  db.update(schema.syncJobs)
    .set({ status: SyncJobStatus.BLOCKED, lastError: error })
    .where(eq(schema.syncJobs.id, jobId))
    .run();
}

/**
 * Schedule a job for retry with exponential backoff and jitter.
 * No-op if dryRun is true.
 */
export function scheduleRetry(
  jobId: number,
  nRetries: number,
  error: string,
  dryRun: boolean
): void {
  if (dryRun) return;
  // Exponential backoff with jitter
  const baseDelay = Math.min(BASE_RETRY_DELAY_MS * Math.pow(2, nRetries), MAX_RETRY_DELAY_MS);
  const jitter = Math.random() * baseDelay * 0.5; // 0-50% jitter
  const delay = baseDelay + jitter;
  const retryAt = new Date(Date.now() + delay);

  db.update(schema.syncJobs)
    .set({
      nRetries: nRetries + 1,
      retryAt,
      lastError: error,
    })
    .where(eq(schema.syncJobs.id, jobId))
    .run();

  logger.info(
    `Job ${jobId} scheduled for retry in ${Math.round(delay / 1000)}s (attempt ${nRetries + 1})`
  );
}

/**
 * Process a single job from the queue.
 * Returns true if a job was processed, false if queue is empty.
 */
export async function processNextJob(client: ProtonDriveClient, dryRun: boolean): Promise<boolean> {
  const job = getNextPendingJob();
  if (!job) return false;

  const { id, eventType, localPath, remotePath, nRetries } = job;

  try {
    if (eventType === SyncEventType.DELETE) {
      logger.info(`Deleting: ${remotePath}`);
      const result = await deleteNode(client, remotePath, false);

      if (!result.success) {
        throw new Error(result.error);
      }

      if (result.existed) {
        logger.info(`Deleted: ${remotePath}`);
      } else {
        logger.info(`Already gone: ${remotePath}`);
      }
    } else {
      // CREATE or UPDATE
      const typeLabel = eventType === SyncEventType.CREATE ? 'Creating' : 'Updating';

      logger.info(`${typeLabel}: ${remotePath}`);
      const result = await createNode(client, localPath, remotePath);

      if (!result.success) {
        throw new Error(result.error);
      }

      logger.info(`Success: ${remotePath} -> ${result.nodeUid}`);
    }

    // Job completed successfully
    markJobSynced(id, dryRun);

    return true;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    if (nRetries >= MAX_RETRIES) {
      logger.error(`Job ${id} failed permanently after ${MAX_RETRIES} retries: ${errorMessage}`);
      markJobBlocked(id, errorMessage, dryRun);
    } else {
      scheduleRetry(id, nRetries, errorMessage, dryRun);
    }

    return true;
  }
}

/**
 * Process all pending jobs in the queue.
 * Returns the number of jobs processed.
 */
export async function processAllPendingJobs(
  client: ProtonDriveClient,
  dryRun: boolean
): Promise<number> {
  let count = 0;
  while (await processNextJob(client, dryRun)) {
    count++;
  }
  return count;
}

/**
 * Get counts of jobs by status.
 */
export function getJobCounts(): { pending: number; synced: number; blocked: number } {
  const pending = db
    .select()
    .from(schema.syncJobs)
    .where(eq(schema.syncJobs.status, SyncJobStatus.PENDING))
    .all().length;
  const synced = db
    .select()
    .from(schema.syncJobs)
    .where(eq(schema.syncJobs.status, SyncJobStatus.SYNCED))
    .all().length;
  const blocked = db
    .select()
    .from(schema.syncJobs)
    .where(eq(schema.syncJobs.status, SyncJobStatus.BLOCKED))
    .all().length;

  return { pending, synced, blocked };
}
