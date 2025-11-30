/**
 * Proton Drive - Create File or Directory
 *
 * Creates a file or directory on Proton Drive.
 * - For files: uploads the file content. If the file exists, creates a new revision.
 * - For directories: creates an empty directory. If it exists, does nothing.
 *
 * Path handling:
 * - If the path starts with my_files/, that prefix is stripped.
 * - Parent directories are created automatically if they don't exist.
 */

import { createReadStream, statSync, Stats } from 'fs';
import { Readable } from 'stream';
import { basename, dirname } from 'path';

// ============================================================================
// Types
// ============================================================================

interface NodeData {
    name: string;
    uid: string;
    type: string;
}

interface NodeResult {
    ok: boolean;
    value?: NodeData;
    error?: unknown;
}

interface RootFolderResult {
    ok: boolean;
    value?: { uid: string };
    error?: unknown;
}

interface UploadController {
    pause(): void;
    resume(): void;
    completion(): Promise<string>;
}

interface FileUploader {
    getAvailableName(): Promise<string>;
    writeStream(
        stream: ReadableStream,
        thumbnails: [],
        onProgress?: (uploadedBytes: number) => void
    ): Promise<UploadController>;
}

interface FileRevisionUploader {
    writeStream(
        stream: ReadableStream,
        thumbnails: [],
        onProgress?: (uploadedBytes: number) => void
    ): Promise<UploadController>;
}

interface UploadMetadata {
    mediaType: string;
    expectedSize: number;
    modificationTime?: Date;
}

interface CreateFolderResult {
    ok: boolean;
    value?: { uid: string };
    error?: unknown;
}

export interface ProtonDriveClient {
    iterateFolderChildren(folderUid: string): AsyncIterable<NodeResult>;
    getMyFilesRootFolder(): Promise<RootFolderResult>;
    createFolder(
        parentNodeUid: string,
        name: string,
        modificationTime?: Date
    ): Promise<CreateFolderResult>;
    getFileUploader(
        parentFolderUid: string,
        name: string,
        metadata: UploadMetadata,
        signal?: AbortSignal
    ): Promise<FileUploader>;
    getFileRevisionUploader(
        nodeUid: string,
        metadata: UploadMetadata,
        signal?: AbortSignal
    ): Promise<FileRevisionUploader>;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert a Node.js Readable stream to a Web ReadableStream
 */
function nodeStreamToWebStream(nodeStream: Readable): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            nodeStream.on('data', (chunk: Buffer) => {
                controller.enqueue(new Uint8Array(chunk));
            });
            nodeStream.on('end', () => {
                controller.close();
            });
            nodeStream.on('error', (err) => {
                controller.error(err);
            });
        },
        cancel() {
            nodeStream.destroy();
        },
    });
}

/**
 * Find an existing file by name in a folder.
 *
 * Note: We iterate through ALL children even after finding a match to ensure
 * the SDK's cache is marked as "children complete". See findFolderByName for details.
 */
async function findFileByName(
    client: ProtonDriveClient,
    folderUid: string,
    fileName: string
): Promise<string | null> {
    let foundUid: string | null = null;
    for await (const node of client.iterateFolderChildren(folderUid)) {
        if (!foundUid && node.ok && node.value?.name === fileName && node.value.type === 'file') {
            foundUid = node.value.uid;
        }
    }
    return foundUid;
}

/**
 * Find a folder by name in a parent folder.
 * Returns the folder UID if found, null otherwise.
 *
 * Note: We iterate through ALL children even after finding a match to ensure
 * the SDK's cache is marked as "children complete". The SDK only sets the
 * `isFolderChildrenLoaded` flag after full iteration. If we exit early, the
 * cache flag isn't set, and subsequent calls would hit the API again.
 */
async function findFolderByName(
    client: ProtonDriveClient,
    parentFolderUid: string,
    folderName: string
): Promise<string | null> {
    let foundUid: string | null = null;
    for await (const node of client.iterateFolderChildren(parentFolderUid)) {
        if (
            !foundUid &&
            node.ok &&
            node.value?.type === 'folder' &&
            node.value.name === folderName
        ) {
            foundUid = node.value.uid;
        }
    }
    return foundUid;
}

/**
 * Parse a path and return its components.
 * Strips my_files/ prefix if present.
 * Returns { parentParts: string[], name: string }
 */
function parsePath(localPath: string): { parentParts: string[]; name: string } {
    let relativePath = localPath;

    // Strip my_files/ prefix if present
    if (relativePath.startsWith('my_files/')) {
        relativePath = relativePath.slice('my_files/'.length);
    } else if (relativePath.startsWith('./my_files/')) {
        relativePath = relativePath.slice('./my_files/'.length);
    }

    // Remove trailing slash for directories
    if (relativePath.endsWith('/')) {
        relativePath = relativePath.slice(0, -1);
    }

    const name = basename(relativePath);
    const dirPath = dirname(relativePath);

    // If there's no directory (item is at root), return empty array
    if (dirPath === '.' || dirPath === '') {
        return { parentParts: [], name };
    }

    // Split by / to get folder components
    const parentParts = dirPath.split('/').filter((part) => part.length > 0);
    return { parentParts, name };
}

/**
 * Ensure all directories in the path exist, creating them if necessary.
 * Returns the UID of the final (deepest) folder.
 *
 * This is O(d) API calls where d = path depth, which is unavoidable for tree traversal.
 * Once we need to create a folder, all subsequent folders must be created (no more searching).
 */
async function ensureRemotePath(
    client: ProtonDriveClient,
    rootFolderUid: string,
    pathParts: string[]
): Promise<string> {
    let currentFolderUid = rootFolderUid;
    let needToCreate = false;

    for (const folderName of pathParts) {
        if (needToCreate) {
            // Once we start creating, all subsequent folders need to be created
            console.log(`  Creating folder: ${folderName}`);
            const result = await client.createFolder(currentFolderUid, folderName);
            if (!result.ok) {
                throw new Error(`Failed to create folder "${folderName}": ${result.error}`);
            }
            currentFolderUid = result.value!.uid;
        } else {
            // Search for existing folder
            const existingFolderUid = await findFolderByName(client, currentFolderUid, folderName);

            if (existingFolderUid) {
                console.log(`  Found existing folder: ${folderName}`);
                currentFolderUid = existingFolderUid;
            } else {
                // Folder doesn't exist, create it and all subsequent folders
                console.log(`  Creating folder: ${folderName}`);
                const result = await client.createFolder(currentFolderUid, folderName);
                if (!result.ok) {
                    throw new Error(`Failed to create folder "${folderName}": ${result.error}`);
                }
                currentFolderUid = result.value!.uid;
                needToCreate = true; // All subsequent folders must be created
            }
        }
    }

    return currentFolderUid;
}

function formatSize(bytes: number): string {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unitIndex = 0;
    let size = bytes;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }
    return `${size.toFixed(2)} ${units[unitIndex]}`;
}

// ============================================================================
// File Upload
// ============================================================================

async function uploadFile(
    client: ProtonDriveClient,
    targetFolderUid: string,
    localFilePath: string,
    fileName: string,
    fileStat: Stats
): Promise<string> {
    const fileSize = Number(fileStat.size);

    // Check if file already exists in the target folder
    console.log(`Checking if "${fileName}" already exists...`);
    const existingFileUid = await findFileByName(client, targetFolderUid, fileName);

    const metadata: UploadMetadata = {
        mediaType: 'application/octet-stream',
        expectedSize: fileSize,
        modificationTime: fileStat.mtime,
    };

    let uploadController: UploadController;

    if (existingFileUid) {
        console.log(`File exists, uploading new revision...`);

        const revisionUploader = await client.getFileRevisionUploader(existingFileUid, metadata);

        const nodeStream = createReadStream(localFilePath);
        const webStream = nodeStreamToWebStream(nodeStream);

        uploadController = await revisionUploader.writeStream(webStream, [], (uploadedBytes) => {
            const percent = ((uploadedBytes / fileSize) * 100).toFixed(1);
            process.stdout.write(
                `\rUploading: ${formatSize(uploadedBytes)} / ${formatSize(fileSize)} (${percent}%)`
            );
        });
    } else {
        console.log(`File doesn't exist, creating new file...`);

        const fileUploader = await client.getFileUploader(targetFolderUid, fileName, metadata);

        const nodeStream = createReadStream(localFilePath);
        const webStream = nodeStreamToWebStream(nodeStream);

        uploadController = await fileUploader.writeStream(webStream, [], (uploadedBytes) => {
            const percent = ((uploadedBytes / fileSize) * 100).toFixed(1);
            process.stdout.write(
                `\rUploading: ${formatSize(uploadedBytes)} / ${formatSize(fileSize)} (${percent}%)`
            );
        });
    }

    // Wait for completion
    const nodeUid = await uploadController.completion();
    console.log('\n');
    console.log(`Upload complete!`);
    console.log(`Node UID: ${nodeUid}`);
    return nodeUid;
}

// ============================================================================
// Directory Creation
// ============================================================================

async function createDirectory(
    client: ProtonDriveClient,
    targetFolderUid: string,
    dirName: string
): Promise<string> {
    // Check if directory already exists
    console.log(`Checking if "${dirName}" already exists...`);
    const existingFolderUid = await findFolderByName(client, targetFolderUid, dirName);

    if (existingFolderUid) {
        console.log(`Directory already exists.`);
        console.log(`Node UID: ${existingFolderUid}`);
        return existingFolderUid;
    } else {
        console.log(`Creating directory: ${dirName}`);
        const result = await client.createFolder(targetFolderUid, dirName);
        if (!result.ok) {
            throw new Error(`Failed to create directory "${dirName}": ${result.error}`);
        }
        console.log(`Directory created!`);
        console.log(`Node UID: ${result.value!.uid}`);
        return result.value!.uid;
    }
}

// ============================================================================
// Public API
// ============================================================================

export interface CreateResult {
    success: boolean;
    nodeUid?: string;
    error?: string;
    isDirectory: boolean;
}

/**
 * Create a file or directory on Proton Drive.
 *
 * @param client - The Proton Drive client
 * @param localPath - The local path (e.g., "my_files/foo/bar.txt")
 * @returns CreateResult with success status and node UID
 */
export async function create(client: ProtonDriveClient, localPath: string): Promise<CreateResult> {
    // Check if path exists locally
    let pathStat: Stats | null = null;
    let isDirectory = false;

    try {
        pathStat = statSync(localPath);
        isDirectory = pathStat.isDirectory();
    } catch {
        // Path doesn't exist locally - treat as directory creation if ends with /
        if (localPath.endsWith('/')) {
            isDirectory = true;
        } else {
            return {
                success: false,
                error: `Path not found: ${localPath}. For creating a new directory, add a trailing slash.`,
                isDirectory: false,
            };
        }
    }

    const { parentParts, name } = parsePath(localPath);

    if (isDirectory) {
        console.log(`Creating directory: ${localPath}`);
    } else {
        console.log(`Uploading file: ${localPath} (${formatSize(pathStat!.size)})`);
    }

    // Get root folder
    const rootFolder = await client.getMyFilesRootFolder();

    if (!rootFolder.ok) {
        return {
            success: false,
            error: `Failed to get root folder: ${rootFolder.error}`,
            isDirectory,
        };
    }

    const rootFolderUid = rootFolder.value!.uid;

    // Ensure parent directories exist
    let targetFolderUid = rootFolderUid;

    if (parentParts.length > 0) {
        console.log(`Ensuring parent path exists: ${parentParts.join('/')}`);
        targetFolderUid = await ensureRemotePath(client, rootFolderUid, parentParts);
    }

    // Create file or directory
    try {
        if (isDirectory) {
            const nodeUid = await createDirectory(client, targetFolderUid, name);
            return { success: true, nodeUid, isDirectory: true };
        } else {
            const nodeUid = await uploadFile(client, targetFolderUid, localPath, name, pathStat!);
            return { success: true, nodeUid, isDirectory: false };
        }
    } catch (error) {
        return {
            success: false,
            error: (error as Error).message,
            isDirectory,
        };
    }
}
