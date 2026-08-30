const LOG_PREFIX = '[FeedbackReport]';
const FEEDBACK_ENDPOINT = '/api/puxin/feedback';
type FeedbackLogLevel = 'info' | 'warn' | 'error';
type FeedbackLogAttachmentStatus = 'collected' | 'empty' | 'failed' | 'skipped' | 'unavailable';

export type FeedbackAttachment = {
  filename: string;
  data: Uint8Array<ArrayBuffer>;
  contentType: string;
};

export type FeedbackEventTags = Record<string, string>;
export type FeedbackEventExtra = Record<string, unknown>;

export type SubmitFeedbackReportInput = {
  attachments?: FeedbackAttachment[];
  collectLogs?: boolean;
  description: string;
  extra?: FeedbackEventExtra;
  flushTimeoutMs?: number;
  module: string;
  moduleLabel: string;
  tags?: FeedbackEventTags;
};

function summarizeAttachments(attachments: FeedbackAttachment[]): Array<{
  contentType: string;
  filename: string;
  size: number;
}> {
  return attachments.map((attachment) => ({
    filename: attachment.filename,
    contentType: attachment.contentType,
    size: attachment.data.byteLength,
  }));
}

function normalizeLogDetails(details: unknown): unknown {
  if (details instanceof Error) {
    return {
      name: details.name,
      message: details.message,
      stack: details.stack,
    };
  }
  return details;
}

export function logFeedbackReport(level: FeedbackLogLevel, message: string, details?: unknown): void {
  const normalizedDetails = normalizeLogDetails(details);
  const consoleMessage = `${LOG_PREFIX} ${message}`;
  if (level === 'error') {
    console.error(consoleMessage, normalizedDetails);
  } else if (level === 'warn') {
    console.warn(consoleMessage, normalizedDetails);
  } else {
    console.info(consoleMessage, normalizedDetails);
  }

  try {
    window.electronAPI?.logFeedbackEvent?.({
      level,
      message,
      details: normalizedDetails,
    });
  } catch {
    // Renderer console logging above is the fallback.
  }
}

async function collectLogAttachment(): Promise<{
  attachment: FeedbackAttachment | null;
  status: FeedbackLogAttachmentStatus;
}> {
  try {
    const electronAPI = typeof window === 'undefined' ? undefined : window.electronAPI;
    if (!electronAPI?.collectFeedbackLogs) {
      return { attachment: null, status: 'unavailable' };
    }

    const logData = await electronAPI.collectFeedbackLogs();
    if (!logData) {
      return { attachment: null, status: 'empty' };
    }

    return {
      attachment: {
        filename: logData.filename,
        data: new Uint8Array(logData.data),
        contentType: 'application/gzip',
      },
      status: 'collected',
    };
  } catch {
    return { attachment: null, status: 'failed' };
  }
}

function bytesToBase64(data: Uint8Array<ArrayBuffer>): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < data.length; offset += chunkSize) {
    binary += String.fromCharCode(...data.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export async function submitFeedbackReport(input: SubmitFeedbackReportInput): Promise<void> {
  const attachments = [...(input.attachments ?? [])];
  let logAttachmentStatus: FeedbackLogAttachmentStatus = input.collectLogs ? 'empty' : 'skipped';

  try {
    if (input.collectLogs) {
      const collectedLogAttachment = await collectLogAttachment();
      logAttachmentStatus = collectedLogAttachment.status;
      if (collectedLogAttachment.attachment) {
        attachments.unshift(collectedLogAttachment.attachment);
      }
    }

    const controller = new AbortController();
    const timeout =
      input.flushTimeoutMs === undefined
        ? undefined
        : window.setTimeout(() => controller.abort(), input.flushTimeoutMs);
    let response: Response;
    try {
      response = await fetch(FEEDBACK_ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          module: input.module,
          moduleLabel: input.moduleLabel,
          description: input.description.trim(),
          tags: input.tags ?? {},
          extra: input.extra ?? {},
          attachments: attachments.map((attachment) => ({
            filename: attachment.filename,
            contentType: attachment.contentType,
            data: bytesToBase64(attachment.data),
          })),
        }),
      });
    } finally {
      if (timeout !== undefined) {
        window.clearTimeout(timeout);
      }
    }

    if (!response.ok) {
      throw new Error(`Local feedback storage returned HTTP ${response.status}`);
    }

    logFeedbackReport('info', 'saved locally', {
      module: input.module,
      collectLogs: Boolean(input.collectLogs),
      logAttachmentStatus,
      attachmentCount: attachments.length,
      attachments: summarizeAttachments(attachments),
    });
  } catch (error) {
    logFeedbackReport('error', 'local save failed', {
      module: input.module,
      collectLogs: Boolean(input.collectLogs),
      logAttachmentStatus,
      attachmentCount: attachments.length,
      attachments: summarizeAttachments(attachments),
      error,
    });
    throw error;
  }
}
