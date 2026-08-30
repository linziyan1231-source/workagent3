const snippets: never[] = [];
export function usePreviewContext() {
  return {
    setSendBoxHandler: (_handler: ((text: string) => void) | null) => undefined,
    domSnippets: snippets,
    removeDomSnippet: (_id: string) => undefined,
    clearDomSnippets: () => undefined,
  };
}
