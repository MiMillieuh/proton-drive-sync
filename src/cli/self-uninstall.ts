/**
 * Self-Uninstall Command - Completely uninstall proton-drive-sync
 */

import { confirm } from '@inquirer/prompts';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { basename, join } from 'path';
import { logger } from '../logger.js';
import { serviceUninstallCommand } from './service/index.js';
import { deleteStoredCredentials } from '../keychain.js';
import { getConfigDir, getStateDir } from '../paths.js';

// ============================================================================
// Constants
// ============================================================================

const APP = 'proton-drive-sync';

// Shell config files to check for PATH entries (Unix only)
const SHELL_CONFIG_FILES: Record<string, string[]> = {
  fish: ['~/.config/fish/config.fish'],
  zsh: ['~/.zshrc', '~/.zshenv', '~/.config/zsh/.zshrc', '~/.config/zsh/.zshenv'],
  bash: [
    '~/.bashrc',
    '~/.bash_profile',
    '~/.profile',
    '~/.config/bash/.bashrc',
    '~/.config/bash/.bash_profile',
  ],
  ash: ['~/.ashrc', '~/.profile'],
  sh: ['~/.ashrc', '~/.profile'],
};

// ============================================================================
// Helpers
// ============================================================================

/**
 * Expand ~ to home directory
 */
function expandHome(filePath: string): string {
  if (filePath.startsWith('~/')) {
    return join(process.env.HOME || '', filePath.slice(2));
  }
  return filePath;
}

/**
 * Get the binary path
 */
function getBinaryPath(): string {
  const execPath = process.execPath;
  // If running via bun in dev mode, the binary won't be at execPath
  if (execPath.includes('bun')) {
    // Check common install locations
    const home = process.env.HOME || '';
    if (process.platform === 'win32') {
      const winPath = join(process.env.LOCALAPPDATA || '', APP, 'bin', `${APP}.exe`);
      if (existsSync(winPath)) return winPath;
    } else {
      const unixPath = join(home, '.local', 'bin', APP);
      if (existsSync(unixPath)) return unixPath;
    }
    return execPath; // Fallback
  }
  return execPath;
}

/**
 * Remove PATH entries from a shell config file (Unix only)
 * Removes lines containing "# proton-drive-sync" and the following line
 */
function removeFromShellConfig(filePath: string): boolean {
  const expanded = expandHome(filePath);
  if (!existsSync(expanded)) return false;

  try {
    const content = readFileSync(expanded, 'utf-8');
    if (!content.includes('# proton-drive-sync')) return false;

    // Remove the comment line and the following line (PATH export)
    const lines = content.split('\n');
    const newLines: string[] = [];
    let skipNext = false;

    for (const line of lines) {
      if (skipNext) {
        skipNext = false;
        continue;
      }
      if (line.includes('# proton-drive-sync')) {
        skipNext = true;
        continue;
      }
      newLines.push(line);
    }

    writeFileSync(expanded, newLines.join('\n'));
    logger.info(`Removed PATH entry from ${filePath}`);
    return true;
  } catch {
    // Ignore errors (permission issues, etc.)
    return false;
  }
}

/**
 * Remove PATH entries from all shell config files (Unix only)
 */
function cleanUnixPath(): void {
  const shell = basename(process.env.SHELL || 'bash');
  const configFiles = SHELL_CONFIG_FILES[shell] || SHELL_CONFIG_FILES.bash;

  // Also check default files that might have been modified
  const allFiles = new Set([
    ...configFiles,
    '~/.bashrc',
    '~/.bash_profile',
    '~/.profile',
    '~/.zshrc',
    '~/.zshenv',
  ]);

  for (const file of allFiles) {
    removeFromShellConfig(file);
  }
}

/**
 * Clean PATH environment variable (Windows only)
 */
function cleanWindowsPath(): void {
  try {
    // Get current user PATH
    const result = Bun.spawnSync(['reg', 'query', 'HKCU\\Environment', '/v', 'Path']);
    if (result.exitCode !== 0) return;

    const output = new TextDecoder().decode(result.stdout);
    const match = output.match(/Path\s+REG_[A-Z_]+\s+(.+)/i);
    if (!match) return;

    const currentPath = match[1].trim();
    const pathParts = currentPath.split(';').filter((p) => p && !p.includes(APP));
    const newPath = pathParts.join(';');

    if (newPath !== currentPath) {
      // Update PATH via setx
      Bun.spawnSync(['setx', 'Path', newPath]);
      logger.info('Cleaned PATH environment variable');
    }
  } catch {
    // Ignore errors
  }
}

/**
 * Remove Linux system directories (requires sudo)
 */
function cleanLinuxSystemDirs(): void {
  const systemDirs = ['/etc/proton-drive-sync', '/var/lib/proton-drive-sync'];

  for (const dir of systemDirs) {
    if (existsSync(dir)) {
      logger.info(`Removing ${dir} (requires sudo)...`);
      const result = Bun.spawnSync(['sudo', 'rm', '-rf', dir]);
      if (result.exitCode === 0) {
        logger.info(`Removed ${dir}`);
      } else {
        logger.warn(`Failed to remove ${dir}`);
      }
    }
  }
}

/**
 * Delete a directory recursively
 */
function deleteDirectory(dir: string, label: string): void {
  if (existsSync(dir)) {
    try {
      rmSync(dir, { recursive: true, force: true });
      logger.info(`Removed ${label}: ${dir}`);
    } catch (err) {
      logger.warn(`Failed to remove ${dir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

// ============================================================================
// Main Command
// ============================================================================

export async function selfUninstallCommand(options: { yes?: boolean }): Promise<void> {
  const { yes } = options;

  // Step 1: Confirmation prompt
  if (!yes) {
    const confirmed = await confirm({
      message: 'This will uninstall proton-drive-sync. Continue?',
      default: false,
    });

    if (!confirmed) {
      logger.info('Aborted.');
      return;
    }
  }

  logger.info('');
  logger.info('Uninstalling proton-drive-sync...');
  logger.info('');

  // Step 2: Uninstall service (non-interactive, ignore errors)
  try {
    logger.info('Removing service...');
    await serviceUninstallCommand(false);
  } catch {
    // Service may not be installed, ignore
  }

  // Step 3: Clear stored credentials from keychain
  try {
    logger.info('Clearing stored credentials...');
    await deleteStoredCredentials();
    logger.info('Credentials cleared from keychain.');
  } catch {
    // May not have credentials stored, ignore
  }

  // Step 4: Platform-specific PATH cleanup
  if (process.platform === 'win32') {
    logger.info('Cleaning PATH environment variable...');
    cleanWindowsPath();
  } else {
    logger.info('Removing PATH entries from shell config files...');
    cleanUnixPath();
  }

  // Step 5: Linux-specific system directory cleanup
  if (process.platform === 'linux') {
    cleanLinuxSystemDirs();
  }

  // Step 6: Prompt for data deletion (always prompt, even with -y)
  logger.info('');
  const deleteData = await confirm({
    message: 'Delete configuration and sync history? This cannot be undone.',
    default: false,
  });

  if (deleteData) {
    const configDir = getConfigDir();
    const stateDir = getStateDir();

    deleteDirectory(configDir, 'configuration');
    deleteDirectory(stateDir, 'state/sync history');
  } else {
    logger.info('Configuration preserved.');
  }

  // Step 7: Print completion message
  const binaryPath = getBinaryPath();

  logger.info('');
  logger.info('========================================');
  logger.info('  Uninstallation complete!');
  logger.info('========================================');
  logger.info('');
  logger.info('To finish, manually delete the binary:');
  logger.info(`  rm "${binaryPath}"`);

  if (process.platform === 'linux') {
    logger.info('');
    logger.info('Note: The following packages were installed as dependencies and may be');
    logger.info('used by other applications. Remove them manually if no longer needed:');
    logger.info('  sudo apt remove libsecret-1-0 jq');
  }

  logger.info('');
  logger.info('You may need to restart your terminal for PATH changes to take effect.');
  logger.info('');
}
