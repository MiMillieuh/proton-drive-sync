#!/usr/bin/env node

/**
 * Proton Drive - List All Files CLI
 *
 * Lists all files in your Proton Drive including My Files, Shared, and Trash.
 *
 * Usage:
 *   node list-files.js [options]
 */

import * as readline from 'readline';
import {
    ProtonAuth,
    createProtonHttpClient,
    createProtonAccount,
    createSrpModule,
    createOpenPGPCrypto,
    initCrypto,
} from './auth.js';

// ============================================================================
// CLI Argument Parsing
// ============================================================================

const args = process.argv.slice(2);

const options = {
    help: args.includes('--help') || args.includes('-h'),
    myFiles: !args.includes('--no-my-files'),
    shared: !args.includes('--no-shared'),
    trash: !args.includes('--no-trash'),
    json: args.includes('--json'),
    username: getArgValue('--username') || getArgValue('-u'),
    password: getArgValue('--password') || getArgValue('-p'),
};

function getArgValue(flag) {
    const index = args.indexOf(flag);
    if (index !== -1 && args[index + 1]) {
        return args[index + 1];
    }
    return null;
}

if (options.help) {
    console.log(`
Proton Drive - List All Files

Usage:
  node list-files.js [options]

Options:
  -h, --help              Show this help message
  -u, --username <user>   Proton username (will prompt if not provided)
  -p, --password <pass>   Password (will prompt if not provided)
  --no-my-files           Skip listing files in "My Files"
  --no-shared             Skip listing shared files
  --no-trash              Skip listing trashed files
  --json                  Output as JSON instead of formatted text

Examples:
  node list-files.js                          # Interactive login
  node list-files.js -u myuser                # Provide username, prompt for password
  node list-files.js --no-trash               # List files except trash
  node list-files.js --json                   # Output as JSON

Security Note:
  Avoid passing password via command line in production.
  The interactive prompt is more secure.
`);
    process.exit(0);
}

// ============================================================================
// Interactive Prompt
// ============================================================================

async function prompt(question, hidden = false) {
    // For non-hidden prompts, use readline normally
    if (!hidden) {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
        });

        return new Promise((resolve) => {
            rl.question(question, (answer) => {
                rl.close();
                resolve(answer);
            });
        });
    }

    // For hidden input (password), handle manually
    return new Promise((resolve) => {
        process.stdout.write(question);
        let password = '';

        // Check if we can use raw mode (TTY only)
        if (!process.stdin.isTTY) {
            // Fallback for non-TTY: use readline (password will be visible)
            const rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout,
            });
            rl.question('', (answer) => {
                rl.close();
                resolve(answer);
            });
            return;
        }

        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.setEncoding('utf8');

        const onData = (char) => {
            char = char.toString();

            switch (char) {
                case '\n':
                case '\r':
                case '\u0004': // Ctrl+D
                    process.stdin.setRawMode(false);
                    process.stdin.pause();
                    process.stdin.removeListener('data', onData);
                    process.stdout.write('\n');
                    resolve(password);
                    break;
                case '\u0003': // Ctrl+C
                    process.stdin.setRawMode(false);
                    process.stdout.write('\n');
                    process.exit(0);
                    break;
                case '\u007F': // Backspace (macOS/Linux)
                case '\b': // Backspace (Windows)
                    if (password.length > 0) {
                        password = password.slice(0, -1);
                    }
                    break;
                default:
                    // Only add printable characters
                    if (char.charCodeAt(0) >= 32) {
                        password += char;
                    }
                    break;
            }
        };

        process.stdin.on('data', onData);
    });
}

// ============================================================================
// File Listing Functions
// ============================================================================

/**
 * Collects all files recursively from a folder
 */
async function collectFilesRecursively(client, folderUid, path = '', signal) {
    const results = [];

    for await (const node of client.iterateFolderChildren(folderUid, signal)) {
        if (!node.ok) {
            results.push({
                type: 'degraded',
                path: path ? `${path}/<unable to decrypt>` : '<unable to decrypt>',
                error: 'Decryption failed',
            });
            continue;
        }

        const nodeData = node.data;
        const fullPath = path ? `${path}/${nodeData.name}` : nodeData.name;

        if (nodeData.type === 'folder') {
            results.push({
                type: 'folder',
                name: nodeData.name,
                path: fullPath,
                uid: nodeData.uid,
                createdAt: nodeData.creationTime?.toISOString() ?? null,
                isShared: nodeData.isShared,
            });

            const children = await collectFilesRecursively(client, nodeData.uid, fullPath, signal);
            results.push(...children);
        } else {
            results.push({
                type: 'file',
                name: nodeData.name,
                path: fullPath,
                uid: nodeData.uid,
                size: nodeData.activeRevision?.claimedSize ?? null,
                mimeType: nodeData.mimeType ?? null,
                modifiedAt: nodeData.activeRevision?.claimedModificationTime?.toISOString() ?? null,
                createdAt: nodeData.creationTime?.toISOString() ?? null,
                isShared: nodeData.isShared,
            });
        }
    }

    return results;
}

/**
 * Format bytes to human readable size
 */
function formatSize(bytes) {
    if (typeof bytes !== 'number' || bytes === null) return 'unknown';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let unitIndex = 0;
    let size = bytes;
    while (size >= 1024 && unitIndex < units.length - 1) {
        size /= 1024;
        unitIndex++;
    }
    return `${size.toFixed(2)} ${units[unitIndex]}`;
}

/**
 * Print files in formatted text output
 */
function printFormatted(section, files) {
    console.log(`\n=== ${section} ===\n`);

    if (files.length === 0) {
        console.log('  (empty)');
        return;
    }

    for (const file of files) {
        if (file.type === 'degraded') {
            console.log(`[DEGRADED] ${file.path}`);
        } else if (file.type === 'folder') {
            console.log(`[FOLDER]   ${file.path}/`);
        } else {
            const size = formatSize(file.size);
            const modified = file.modifiedAt ?? 'unknown';
            console.log(`[FILE]     ${file.path} (${size}, modified: ${modified})`);
        }
    }
}

// ============================================================================
// Main
// ============================================================================

async function main() {
    try {
        // Initialize crypto
        await initCrypto();

        // Get credentials
        const username = options.username || (await prompt('Proton username: '));
        const password = options.password || (await prompt('Password: ', true));

        if (!username || !password) {
            console.error('Username and password are required.');
            process.exit(1);
        }

        // Authenticate
        console.log('\nAuthenticating with Proton...');
        const auth = new ProtonAuth();

        let session;
        try {
            session = await auth.login(username, password);
        } catch (error) {
            if (error.requires2FA) {
                const code = await prompt('Enter 2FA code: ');
                await auth.submit2FA(code);
                session = auth.getSession();
            } else {
                throw error;
            }
        }

        console.log(`Logged in as: ${session.user?.Name || username}\n`);

        // Load the SDK
        let ProtonDriveClient, MemoryCache;
        try {
            const sdk = await import('@protontech/drive-sdk');
            ProtonDriveClient = sdk.ProtonDriveClient;
            MemoryCache = sdk.MemoryCache;
        } catch (error) {
            console.error('Error: Could not load @protontech/drive-sdk');
            console.error('Make sure the SDK is built: cd ../sdk/js/sdk && pnpm build');
            console.error('Original error:', error.message);
            process.exit(1);
        }

        // Create SDK dependencies
        const httpClient = createProtonHttpClient(session);
        const account = createProtonAccount(session);
        const srpModule = createSrpModule();
        const openPGPCryptoModule = createOpenPGPCrypto();

        // Create the Drive client
        const client = new ProtonDriveClient({
            httpClient,
            entitiesCache: new MemoryCache(),
            cryptoCache: new MemoryCache(),
            account,
            openPGPCryptoModule,
            srpModule,
        });

        const output = {
            myFiles: [],
            shared: [],
            trash: [],
        };

        // Get "My Files"
        if (options.myFiles) {
            console.log('Fetching My Files...');
            const rootFolder = await client.getMyFilesRootFolder();

            if (!rootFolder.ok) {
                console.error('Failed to get root folder:', rootFolder.error);
            } else {
                output.myFiles = await collectFilesRecursively(client, rootFolder.data.uid);
            }
        }

        // Get shared files
        if (options.shared) {
            console.log('Fetching shared files...');
            for await (const node of client.iterateSharedNodesWithMe()) {
                if (!node.ok) {
                    output.shared.push({
                        type: 'degraded',
                        path: '<unable to decrypt>',
                        error: 'Decryption failed',
                    });
                    continue;
                }

                const nodeData = node.data;

                if (nodeData.type === 'folder') {
                    output.shared.push({
                        type: 'folder',
                        name: nodeData.name,
                        path: nodeData.name,
                        uid: nodeData.uid,
                    });

                    const children = await collectFilesRecursively(client, nodeData.uid, nodeData.name);
                    output.shared.push(...children);
                } else {
                    output.shared.push({
                        type: 'file',
                        name: nodeData.name,
                        path: nodeData.name,
                        uid: nodeData.uid,
                        size: nodeData.activeRevision?.claimedSize ?? null,
                        modifiedAt: nodeData.activeRevision?.claimedModificationTime?.toISOString() ?? null,
                    });
                }
            }
        }

        // Get trashed files
        if (options.trash) {
            console.log('Fetching trash...');
            for await (const node of client.iterateTrashedNodes()) {
                if (!node.ok) {
                    output.trash.push({
                        type: 'degraded',
                        path: '<unable to decrypt>',
                        error: 'Decryption failed',
                    });
                    continue;
                }

                const nodeData = node.data;
                output.trash.push({
                    type: nodeData.type,
                    name: nodeData.name,
                    path: nodeData.name,
                    uid: nodeData.uid,
                    trashedAt: nodeData.trashTime?.toISOString() ?? null,
                });
            }
        }

        // Output results
        if (options.json) {
            console.log(JSON.stringify(output, null, 2));
        } else {
            console.log('\nProton Drive Files');
            console.log('==================');

            if (options.myFiles) {
                printFormatted('My Files', output.myFiles);
            }
            if (options.shared) {
                printFormatted('Shared with me', output.shared);
            }
            if (options.trash) {
                printFormatted('Trash', output.trash);
            }

            // Summary
            const totalFiles =
                output.myFiles.filter((f) => f.type === 'file').length +
                output.shared.filter((f) => f.type === 'file').length;
            const totalFolders =
                output.myFiles.filter((f) => f.type === 'folder').length +
                output.shared.filter((f) => f.type === 'folder').length;
            const totalTrashed = output.trash.length;

            console.log('\n---');
            console.log(`Total: ${totalFiles} files, ${totalFolders} folders, ${totalTrashed} trashed items`);
        }

        // Logout
        await auth.logout();
    } catch (error) {
        console.error('\nError:', error.message);
        if (error.code) {
            console.error('Error code:', error.code);
        }
        process.exit(1);
    }
}

// Run
main();
