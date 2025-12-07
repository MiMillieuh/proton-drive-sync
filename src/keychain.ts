/**
 * Keychain utilities for storing and retrieving Proton credentials
 */

// @ts-expect-error - keychain doesn't have type definitions
import keychain from 'keychain';
import { promisify } from 'util';

const KEYCHAIN_SERVICE = 'proton-drive-sync';
const KEYCHAIN_ACCOUNT_PREFIX = 'proton-drive-sync:';

const keychainGetPassword = promisify(keychain.getPassword).bind(keychain);
const keychainSetPassword = promisify(keychain.setPassword).bind(keychain);
const keychainDeletePassword = promisify(keychain.deletePassword).bind(keychain);

export interface StoredCredentials {
  username: string;
  password: string;
}

export async function getStoredCredentials(): Promise<StoredCredentials | null> {
  try {
    const username = await keychainGetPassword({
      account: `${KEYCHAIN_ACCOUNT_PREFIX}username`,
      service: KEYCHAIN_SERVICE,
    });
    const pwd = await keychainGetPassword({
      account: `${KEYCHAIN_ACCOUNT_PREFIX}password`,
      service: KEYCHAIN_SERVICE,
    });
    return { username, password: pwd };
  } catch {
    return null;
  }
}

export async function storeCredentials(username: string, pwd: string): Promise<void> {
  await keychainSetPassword({
    account: `${KEYCHAIN_ACCOUNT_PREFIX}username`,
    service: KEYCHAIN_SERVICE,
    password: username,
  });
  await keychainSetPassword({
    account: `${KEYCHAIN_ACCOUNT_PREFIX}password`,
    service: KEYCHAIN_SERVICE,
    password: pwd,
  });
}

export async function deleteStoredCredentials(): Promise<void> {
  try {
    await keychainDeletePassword({
      account: `${KEYCHAIN_ACCOUNT_PREFIX}username`,
      service: KEYCHAIN_SERVICE,
    });
  } catch {
    // Ignore
  }
  try {
    await keychainDeletePassword({
      account: `${KEYCHAIN_ACCOUNT_PREFIX}password`,
      service: KEYCHAIN_SERVICE,
    });
  } catch {
    // Ignore
  }
}
