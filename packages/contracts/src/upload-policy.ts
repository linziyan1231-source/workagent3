// Shared by server validation and the generated browser client.
export const MAX_UPLOAD_BYTES = 5 * 1024 ** 3;
export const UPLOAD_SIZE_LABEL = `${MAX_UPLOAD_BYTES / 1024 ** 3} GB`;
export const UPLOAD_TOO_LARGE_MESSAGE = `超过 ${UPLOAD_SIZE_LABEL}`;
