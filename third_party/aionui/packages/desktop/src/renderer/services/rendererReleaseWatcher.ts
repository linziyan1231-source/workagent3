/**
 * Automatically reload the WebUI when a newly deployed renderer entry is detected.
 * Hashed assets remain cacheable; a tiny conditional endpoint is the release pointer.
 */

const RENDERER_ENTRY_PATTERN = /(?:^|\/)assets\/index-[^"'<>?\s]+\.js/;

export type RendererReleaseCheckResult = 'unchanged' | 'updated' | 'unavailable';

type RendererReleaseCheckOptions = {
  currentEntryUrl: string;
  loadRelease: () => Promise<{ release_id: string; entry_path: string | null }>;
  reload: () => void;
};

export function extractRendererEntryPath(value: string): string | null {
  const match = value.match(RENDERER_ENTRY_PATTERN)?.[0];
  if (!match) return null;
  return match.startsWith('/') ? match : `/${match}`;
}

export async function checkRendererRelease({
  currentEntryUrl,
  loadRelease,
  reload,
}: RendererReleaseCheckOptions): Promise<RendererReleaseCheckResult> {
  const currentEntry = extractRendererEntryPath(currentEntryUrl);
  if (!currentEntry) return 'unavailable';

  try {
    const latestEntry = extractRendererEntryPath((await loadRelease()).entry_path ?? '');
    if (!latestEntry) return 'unavailable';
    if (latestEntry === currentEntry) return 'unchanged';
    reload();
    return 'updated';
  } catch {
    return 'unavailable';
  }
}

async function loadReleaseDescriptor(): Promise<{ release_id: string; entry_path: string | null }> {
  const response = await fetch(new URL('/__aionui/version', window.location.origin), {
    cache: 'no-cache',
    credentials: 'same-origin',
  });
  if (!response.ok) throw new Error(`Renderer release check failed: ${response.status}`);
  return response.json() as Promise<{ release_id: string; entry_path: string | null }>;
}

export function startRendererReleaseWatcher(currentEntryUrl: string): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined' || window.electronAPI) {
    return () => undefined;
  }

  let stopped = false;
  let checking = false;
  let updateDetected = false;

  const check = async (): Promise<void> => {
    if (stopped || checking || updateDetected || document.visibilityState !== 'visible') return;
    checking = true;
    try {
      const result = await checkRendererRelease({
        currentEntryUrl,
        loadRelease: loadReleaseDescriptor,
        reload: () => window.location.reload(),
      });
      updateDetected = result === 'updated';
    } finally {
      checking = false;
    }
  };

  const onVisibilityChange = (): void => {
    if (document.visibilityState === 'visible') void check();
  };
  const onFocus = (): void => void check();
  const onOnline = (): void => void check();

  document.addEventListener('visibilitychange', onVisibilityChange);
  window.addEventListener('focus', onFocus);
  window.addEventListener('online', onOnline);
  void check();

  return () => {
    stopped = true;
    document.removeEventListener('visibilitychange', onVisibilityChange);
    window.removeEventListener('focus', onFocus);
    window.removeEventListener('online', onOnline);
  };
}
