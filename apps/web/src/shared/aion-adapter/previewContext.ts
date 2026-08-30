const snippets: never[] = [];
export function usePreviewContext() {
  return {
    setSendBoxHandler: (_handler: ((text: string) => void) | null) => undefined,
    domSnippets: snippets,
    removeDomSnippet: (_id: string) => undefined,
    clearDomSnippets: () => undefined,
    closePreview: () => undefined,
    clearPreviewForScope: () => undefined,
    isOpen: false,
    isMaximized: false,
  };
}

export const useOptionalPreviewContext = usePreviewContext;

export function PreviewPanel() {
  return null;
}
