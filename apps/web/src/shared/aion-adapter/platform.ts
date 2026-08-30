/** Browser-only replacement for AionUi's Electron-aware platform bridge. */
export const isElectronDesktop = () => false;
export const isMacOS = () => /mac/i.test(navigator.userAgent);
export const isWindows = () => /win/i.test(navigator.userAgent);
export const isLinux = () => /linux/i.test(navigator.userAgent);

export const resolveBackendAssetUrl = (url?: string) => url;
export const resolveExtensionAssetUrl = resolveBackendAssetUrl;

export async function openExternalUrl(url: string): Promise<void> {
  window.open(url, "_blank", "noopener,noreferrer");
}
