export function useBtwCommand() {
  return {
    answer: "",
    isLoading: false,
    isOpen: false,
    question: "",
    dismiss: () => undefined,
    ask: async (_question: string) => undefined,
  };
}
