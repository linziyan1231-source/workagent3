/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

const DATABASE_NAME = 'aionui-resumable-uploads';
const DATABASE_VERSION = 1;
const STORE_NAME = 'sessions';

export interface UploadIdentity {
  fileName: string;
  fileSize: number;
  lastModified: number;
  conversationId: string;
  fingerprint: string;
}

export interface PersistedUploadSession {
  identityKey: string;
  identity: UploadIdentity;
  uploadId: string;
  offset: number;
  chunkSize: number;
  expiresAtUnixMs?: number;
}

export function createUploadIdentityKey(identity: UploadIdentity): string {
  return JSON.stringify([
    identity.fileName,
    identity.fileSize,
    identity.lastModified,
    identity.conversationId,
    identity.fingerprint,
  ]);
}

function getIndexedDb(): IDBFactory | undefined {
  try {
    return typeof globalThis.indexedDB === 'undefined' ? undefined : globalThis.indexedDB;
  } catch {
    return undefined;
  }
}

function openDatabase(): Promise<IDBDatabase | undefined> {
  const indexedDb = getIndexedDb();
  if (!indexedDb) return Promise.resolve(undefined);

  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDb.open(DATABASE_NAME, DATABASE_VERSION);
    } catch (error) {
      reject(error);
      return;
    }

    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'identityKey' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function loadUploadSession(identityKey: string): Promise<PersistedUploadSession | undefined> {
  try {
    const database = await openDatabase();
    if (!database) return undefined;

    const session = await new Promise<PersistedUploadSession | undefined>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readonly');
      const request = transaction.objectStore(STORE_NAME).get(identityKey);
      request.onsuccess = () => resolve(request.result as PersistedUploadSession | undefined);
      request.onerror = () => reject(request.error);
    });
    database.close();

    if (session?.expiresAtUnixMs && session.expiresAtUnixMs <= Date.now()) {
      await removeUploadSession(identityKey);
      return undefined;
    }
    return session;
  } catch {
    return undefined;
  }
}

export async function saveUploadSession(session: PersistedUploadSession): Promise<void> {
  try {
    const database = await openDatabase();
    if (!database) return;

    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).put(session);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  } catch {
    // Uploading must continue when storage is disabled, full, or unavailable.
  }
}

export async function removeUploadSession(identityKey: string): Promise<void> {
  try {
    const database = await openDatabase();
    if (!database) return;

    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, 'readwrite');
      transaction.objectStore(STORE_NAME).delete(identityKey);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  } catch {
    // A stale local record is harmless; the backend session still expires.
  }
}
