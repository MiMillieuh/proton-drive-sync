/**
 * Proton Drive - Delete File or Directory
 *
 * Deletes a file or directory from Proton Drive.
 * - Pass a path (e.g., my_files/foo/bar.txt) and the corresponding remote item is deleted.
 * - If the remote item doesn't exist, does nothing (noop).
 * - By default, moves to trash. Use permanent=true to delete permanently.
 *
 * Path handling:
 * - If the path starts with my_files/, that prefix is stripped.
 */

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

interface DeleteResult {
    ok: boolean;
    error?: unknown;
}

export interface ProtonDriveClient {
    iterateFolderChildren(folderUid: string): AsyncIterable<NodeResult>;
    getMyFilesRootFolder(): Promise<RootFolderResult>;
    trashNodes(nodeUids: string[]): AsyncIterable<DeleteResult>;
    deleteNodes(nodeUids: string[]): AsyncIterable<DeleteResult>;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Find a node (file or folder) by name in a parent folder.
 * Returns { uid, type } if found, null otherwise.
 *
 * Note: We iterate through ALL children even after finding a match to ensure
 * the SDK's cache is marked as "children complete". The SDK only sets the
 * `isFolderChildrenLoaded` flag after full iteration. If we exit early, the
 * cache flag isn't set, and subsequent calls would hit the API again.
 */
async function findNodeByName(
    client: ProtonDriveClient,
    parentFolderUid: string,
    name: string
): Promise<{ uid: string; type: string } | null> {
    let found: { uid: string; type: string } | null = null;
    for await (const node of client.iterateFolderChildren(parentFolderUid)) {
        if (!found && node.ok && node.value?.name === name) {
            found = { uid: node.value.uid, type: node.value.type };
        }
    }
    return found;
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
 * Traverse the remote path and return the UID of the target folder.
 * Returns null if any part of the path doesn't exist.
 */
async function traverseRemotePath(
    client: ProtonDriveClient,
    rootFolderUid: string,
    pathParts: string[]
): Promise<string | null> {
    let currentFolderUid = rootFolderUid;

    for (const folderName of pathParts) {
        const node = await findNodeByName(client, currentFolderUid, folderName);

        if (!node) {
            console.log(`  Path component "${folderName}" not found.`);
            return null;
        }

        if (node.type !== 'folder') {
            console.log(`  Path component "${folderName}" is not a folder.`);
            return null;
        }

        console.log(`  Found folder: ${folderName}`);
        currentFolderUid = node.uid;
    }

    return currentFolderUid;
}

// ============================================================================
// Public API
// ============================================================================

export interface DeleteOperationResult {
    success: boolean;
    existed: boolean;
    nodeUid?: string;
    nodeType?: string;
    error?: string;
}

/**
 * Delete a file or directory from Proton Drive.
 *
 * @param client - The Proton Drive client
 * @param remotePath - The remote path (e.g., "my_files/foo/bar.txt")
 * @param permanent - If true, permanently delete; if false, move to trash (default)
 * @returns DeleteOperationResult with success status
 */
export async function deleteNode(
    client: ProtonDriveClient,
    remotePath: string,
    permanent: boolean = false
): Promise<DeleteOperationResult> {
    const { parentParts, name } = parsePath(remotePath);

    console.log(`Deleting from remote: ${remotePath}`);
    console.log(`  Mode: ${permanent ? 'permanent delete' : 'move to trash'}`);

    // Get root folder
    const rootFolder = await client.getMyFilesRootFolder();

    if (!rootFolder.ok) {
        return {
            success: false,
            existed: false,
            error: `Failed to get root folder: ${rootFolder.error}`,
        };
    }

    const rootFolderUid = rootFolder.value!.uid;

    // Traverse to parent folder
    let targetFolderUid = rootFolderUid;

    if (parentParts.length > 0) {
        console.log(`Traversing path: ${parentParts.join('/')}`);
        const traverseResult = await traverseRemotePath(client, rootFolderUid, parentParts);

        if (!traverseResult) {
            console.log('Path does not exist on remote. Nothing to delete.');
            return { success: true, existed: false };
        }

        targetFolderUid = traverseResult;
    }

    // Find the target node
    console.log(`Looking for "${name}"...`);
    const targetNode = await findNodeByName(client, targetFolderUid, name);

    if (!targetNode) {
        console.log(`"${name}" does not exist on remote. Nothing to delete.`);
        return { success: true, existed: false };
    }

    console.log(`Found ${targetNode.type}: ${name} (${targetNode.uid})`);

    // Delete or trash the node
    try {
        if (permanent) {
            console.log(`Permanently deleting...`);
            for await (const result of client.deleteNodes([targetNode.uid])) {
                if (!result.ok) {
                    throw new Error(`Failed to delete: ${result.error}`);
                }
            }
            console.log(`Permanently deleted!`);
        } else {
            console.log(`Moving to trash...`);
            for await (const result of client.trashNodes([targetNode.uid])) {
                if (!result.ok) {
                    throw new Error(`Failed to trash: ${result.error}`);
                }
            }
            console.log(`Moved to trash!`);
        }

        return {
            success: true,
            existed: true,
            nodeUid: targetNode.uid,
            nodeType: targetNode.type,
        };
    } catch (error) {
        return {
            success: false,
            existed: true,
            nodeUid: targetNode.uid,
            nodeType: targetNode.type,
            error: (error as Error).message,
        };
    }
}
