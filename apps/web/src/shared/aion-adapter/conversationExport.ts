export function useConversationExport() {
  return {
    isOpen: false,
    step: "menu" as const,
    filename: "",
    pathPreview: "",
    menuItems: [],
    activeIndex: 0,
    loading: false,
    setFilename: (_value: string) => undefined,
    setActiveIndex: (_index: number) => undefined,
    onSelectMenuItem: (_key: string) => undefined,
    openExportFlow: async () => undefined,
    closeExportFlow: () => undefined,
    showMenu: () => undefined,
    submitFilename: async () => undefined,
    handleKeyDown: (_event: unknown) => false,
  };
}
