import { useMemo } from "react";

export function createChainedDispatch(
  getValue: () => string,
  setValue: (value: string) => void,
) {
  let pending: string | undefined;
  return {
    dispatch(update: (previous: string) => string) {
      pending = update(pending ?? getValue());
      setValue(pending);
    },
    reset() {
      pending = undefined;
    },
  };
}

export function useLiveTranscriptInsertion(
  dispatch: (update: (previous: string) => string) => void,
) {
  return useMemo(
    () => ({ handleLiveTranscript: (text: string) => dispatch(() => text) }),
    [dispatch],
  );
}
