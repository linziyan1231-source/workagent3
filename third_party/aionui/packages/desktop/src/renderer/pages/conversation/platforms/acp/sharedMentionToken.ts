import type { PortalSharedMention } from '@/common/adapter/ipcBridge';

// The picker encodes mention identity entirely with invisible separators. If a
// user partially deletes a token, no kind/id/nonce payload can become visible;
// all remaining separators are stripped before the message is sent.
export const SHARED_MENTION_MARKER = '\u2062';
const SHARED_MENTION_ZERO = '\u2063';
const SHARED_MENTION_ONE = '\u2064';

export type SelectedSharedMention = PortalSharedMention & { token: string };

export const makeSharedMentionToken = (label: string, kind: string, id: string, nonce: string) => {
  const identity = `${kind}:${encodeURIComponent(id)}:${nonce}`;
  const invisibleIdentity = Array.from(identity)
    .map((character) => character.charCodeAt(0).toString(2).padStart(8, '0'))
    .join('')
    .replaceAll('0', SHARED_MENTION_ZERO)
    .replaceAll('1', SHARED_MENTION_ONE);
  return `@${label}${SHARED_MENTION_MARKER}${invisibleIdentity}${SHARED_MENTION_MARKER}`;
};

export const stripSharedMentionMarkers = (value: string) =>
  value.replace(/[\u2062\u2063\u2064]/gu, '');

export const activeSharedMentions = (draft: string, mentions: SelectedSharedMention[]): PortalSharedMention[] =>
  mentions
    .filter((mention) => draft.includes(mention.token))
    .map(({ token: _token, ...mention }) => mention);
