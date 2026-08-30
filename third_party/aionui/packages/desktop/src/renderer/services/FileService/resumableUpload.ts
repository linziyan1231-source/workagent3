/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { getBaseUrl } from '@/common/adapter/httpBridge';
import { sha256 } from '@noble/hashes/sha2.js';
import {
  createUploadIdentityKey,
  loadUploadSession,
  removeUploadSession,
  saveUploadSession,
  type PersistedUploadSession,
  type UploadIdentity,
} from './uploadSessionStore';

export const UPLOAD_ABORTED_ERROR = 'Upload aborted';
export const MAX_UPLOAD_FILE_SIZE = 1024 * 1024 * 1024;
export const DEFAULT_UPLOAD_CHUNK_SIZE = 16 * 1024 * 1024;

const FINGERPRINT_SLICE_SIZE = 64 * 1024;
const MAX_REQUEST_ATTEMPTS = 4;
const RETRY_BASE_DELAY_MS = 250;
const RETRYABLE_STATUSES = new Set([408, 429]);

interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: string;
}

interface InitializeUploadResponse {
  upload_id: string;
  offset: number;
  file_size: number;
  chunk_size: number;
  fingerprint?: string;
  expires_at_unix_ms?: number;
}

interface ServerUploadState {
  offset: number;
  fileSize: number;
  chunkSize: number;
  fingerprint?: string;
}

export interface ResumableUploadOptions {
  file: File;
  conversationId?: string;
  fileName?: string;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

class UploadRequestError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'UploadRequestError';
    this.status = status;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error(UPLOAD_ABORTED_ERROR);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

function waitForRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timeoutId);
      signal?.removeEventListener('abort', onAbort);
      reject(new Error(UPLOAD_ABORTED_ERROR));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function shouldRetryStatus(status: number): boolean {
  return RETRYABLE_STATUSES.has(status) || status >= 500;
}

async function fetchWithRetry(url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; attempt < MAX_REQUEST_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    try {
      const response = await fetch(url, { ...init, signal });
      if (!shouldRetryStatus(response.status) || attempt === MAX_REQUEST_ATTEMPTS - 1) {
        return response;
      }
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw new Error(UPLOAD_ABORTED_ERROR, { cause: error });
      if (attempt === MAX_REQUEST_ATTEMPTS - 1) {
        throw new Error('Upload failed: network error', { cause: error });
      }
    }
    await waitForRetry(RETRY_BASE_DELAY_MS * 2 ** attempt, signal);
  }
  throw new Error('Upload failed: network error');
}

async function requireSuccessfulResponse(response: Response, action: string): Promise<void> {
  if (response.ok) return;
  if (response.status === 413) throw new Error('FILE_TOO_LARGE');
  const responseText = await response.text().catch(() => '');
  throw new UploadRequestError(
    response.status,
    `Upload ${action} failed: ${response.status}${responseText ? ` ${responseText}` : ''}`
  );
}

async function readApiData<T>(response: Response, action: string): Promise<T> {
  await requireSuccessfulResponse(response, action);
  let result: ApiResponse<T>;
  try {
    result = (await response.json()) as ApiResponse<T>;
  } catch {
    throw new Error(`Upload ${action} failed: invalid server response`);
  }
  if (!result.success || result.data === undefined) {
    throw new Error(`Upload ${action} failed: ${result.error || 'server returned unsuccessful response'}`);
  }
  return result.data;
}

function parseRequiredInteger(value: string | null, headerName: string): number {
  if (value === null || !/^\d+$/.test(value)) {
    throw new Error(`Upload resume failed: invalid ${headerName}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`Upload resume failed: invalid ${headerName}`);
  return parsed;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function sha256Base64(data: ArrayBuffer): Promise<string> {
  // Web Crypto is unavailable on non-localhost HTTP origins. The Portal is
  // currently served over HTTP, so use a browser-safe synchronous SHA-256
  // implementation that works in both secure and insecure contexts.
  return bytesToBase64(sha256(new Uint8Array(data)));
}

export async function createUploadClientRequestId(identityKey: string): Promise<string> {
  const encoded = new TextEncoder().encode(identityKey);
  return bytesToBase64(sha256(encoded));
}

export async function createFileFingerprint(file: File): Promise<string> {
  const first = await file.slice(0, Math.min(file.size, FINGERPRINT_SLICE_SIZE)).arrayBuffer();
  const lastStart = Math.max(0, file.size - FINGERPRINT_SLICE_SIZE);
  const last = await file.slice(lastStart, file.size).arrayBuffer();
  const combined = new Uint8Array(first.byteLength + last.byteLength);
  combined.set(new Uint8Array(first), 0);
  combined.set(new Uint8Array(last), first.byteLength);
  return sha256Base64(combined.buffer);
}

function uploadUrl(uploadId?: string): string {
  const base = `${getBaseUrl()}/api/fs/uploads`;
  return uploadId ? `${base}/${encodeURIComponent(uploadId)}` : base;
}

function validateServerState(state: ServerUploadState, identity: UploadIdentity): void {
  if (state.fileSize !== identity.fileSize) throw new Error('Upload resume failed: file size mismatch');
  if (state.fingerprint && state.fingerprint !== identity.fingerprint) {
    throw new Error('Upload resume failed: fingerprint mismatch');
  }
  if (state.offset < 0 || state.offset > identity.fileSize) {
    throw new Error('Upload resume failed: invalid server offset');
  }
  if (!Number.isSafeInteger(state.chunkSize) || state.chunkSize <= 0) {
    throw new Error('Upload resume failed: invalid chunk size');
  }
}

async function readServerState(uploadId: string, signal?: AbortSignal): Promise<ServerUploadState> {
  const response = await fetchWithRetry(uploadUrl(uploadId), { method: 'HEAD' }, signal);
  await requireSuccessfulResponse(response, 'resume');
  return {
    offset: parseRequiredInteger(response.headers.get('Upload-Offset'), 'Upload-Offset'),
    fileSize: parseRequiredInteger(response.headers.get('Upload-Length'), 'Upload-Length'),
    chunkSize: parseRequiredInteger(response.headers.get('Upload-Chunk-Size'), 'Upload-Chunk-Size'),
    fingerprint: response.headers.get('Upload-Fingerprint') || undefined,
  };
}

async function initializeUpload(
  identity: UploadIdentity,
  identityKey: string,
  signal?: AbortSignal
): Promise<PersistedUploadSession> {
  const clientRequestId = await createUploadClientRequestId(identityKey);
  const response = await fetchWithRetry(
    uploadUrl(),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        file_name: identity.fileName,
        file_size: identity.fileSize,
        ...(identity.conversationId ? { conversation_id: identity.conversationId } : {}),
        fingerprint: identity.fingerprint,
        client_request_id: clientRequestId,
      }),
    },
    signal
  );
  const initialized = await readApiData<InitializeUploadResponse>(response, 'initialization');
  if (!initialized.upload_id || initialized.file_size !== identity.fileSize) {
    throw new Error('Upload initialization failed: invalid server response');
  }
  const serverState: ServerUploadState = {
    offset: initialized.offset,
    fileSize: initialized.file_size,
    chunkSize: initialized.chunk_size,
    fingerprint: initialized.fingerprint,
  };
  validateServerState(serverState, identity);

  const session: PersistedUploadSession = {
    identityKey,
    identity,
    uploadId: initialized.upload_id,
    offset: initialized.offset,
    chunkSize: Math.min(initialized.chunk_size, DEFAULT_UPLOAD_CHUNK_SIZE),
    expiresAtUnixMs: initialized.expires_at_unix_ms,
  };
  await saveUploadSession(session);
  return session;
}

async function loadResumableSession(
  identity: UploadIdentity,
  identityKey: string,
  signal?: AbortSignal
): Promise<PersistedUploadSession | undefined> {
  const saved = await loadUploadSession(identityKey);
  if (!saved) return undefined;

  try {
    const serverState = await readServerState(saved.uploadId, signal);
    validateServerState(serverState, identity);
    const resumed: PersistedUploadSession = {
      ...saved,
      identity,
      offset: serverState.offset,
      chunkSize: Math.min(serverState.chunkSize, DEFAULT_UPLOAD_CHUNK_SIZE),
    };
    await saveUploadSession(resumed);
    return resumed;
  } catch (error) {
    if (error instanceof UploadRequestError && (error.status === 404 || error.status === 410)) {
      await removeUploadSession(identityKey);
      return undefined;
    }
    throw error;
  }
}

async function uploadChunk(
  session: PersistedUploadSession,
  chunk: Blob,
  offset: number,
  signal?: AbortSignal
): Promise<number> {
  const checksum = await sha256Base64(await chunk.arrayBuffer());
  throwIfAborted(signal);
  const response = await fetchWithRetry(
    uploadUrl(session.uploadId),
    {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/offset+octet-stream',
        'Upload-Offset': String(offset),
        'Upload-Checksum': `sha256 ${checksum}`,
      },
      body: chunk,
    },
    signal
  );
  if (response.status === 409) {
    const serverState = await readServerState(session.uploadId, signal);
    validateServerState(serverState, session.identity);
    return serverState.offset;
  }
  await requireSuccessfulResponse(response, 'chunk');
  return parseRequiredInteger(response.headers.get('Upload-Offset'), 'Upload-Offset');
}

function reportProgress(fileSize: number, offset: number, onProgress?: (percent: number) => void): void {
  if (!onProgress) return;
  onProgress(fileSize === 0 ? 100 : Math.round((offset / fileSize) * 100));
}

export async function uploadFileResumably(options: ResumableUploadOptions): Promise<string> {
  const { file, signal, onProgress } = options;
  throwIfAborted(signal);
  if (file.size > MAX_UPLOAD_FILE_SIZE) throw new Error('FILE_TOO_LARGE');

  reportProgress(file.size, 0, onProgress);
  const fingerprint = await createFileFingerprint(file);
  throwIfAborted(signal);
  const identity: UploadIdentity = {
    fileName: options.fileName || file.name,
    fileSize: file.size,
    lastModified: file.lastModified,
    conversationId: options.conversationId || '',
    fingerprint,
  };
  const identityKey = createUploadIdentityKey(identity);
  let session = await loadResumableSession(identity, identityKey, signal);
  session ??= await initializeUpload(identity, identityKey, signal);
  reportProgress(file.size, session.offset, onProgress);

  while (session.offset < file.size) {
    throwIfAborted(signal);
    const expectedEnd = Math.min(session.offset + session.chunkSize, file.size);
    const chunk = file.slice(session.offset, expectedEnd);
    const nextOffset = await uploadChunk(session, chunk, session.offset, signal);
    if (nextOffset <= session.offset || nextOffset > expectedEnd) {
      throw new Error('Upload chunk failed: invalid server offset');
    }
    session = { ...session, offset: nextOffset };
    await saveUploadSession(session);
    reportProgress(file.size, session.offset, onProgress);
  }

  const completeResponse = await fetchWithRetry(`${uploadUrl(session.uploadId)}/complete`, { method: 'POST' }, signal);
  const filePath = await readApiData<string>(completeResponse, 'completion');
  if (!filePath) throw new Error('Upload completion failed: invalid server response');
  await removeUploadSession(identityKey);
  reportProgress(file.size, file.size, onProgress);
  return filePath;
}
