import { useCallback, useState } from "react";

export function appendSpeechTranscript(previous: string, transcript: string) {
  return previous ? `${previous} ${transcript}` : transcript;
}

export function getSpeechInputErrorMessageKey() {
  return "conversation.chat.speech.recordingUnsupported";
}

export function useSpeechInput({
  onTranscript: _onTranscript,
}: {
  onTranscript: (transcript: string) => void;
}) {
  const [status, setStatus] = useState<"idle" | "error">("idle");
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const clearError = useCallback(() => {
    setErrorCode(null);
    setStatus("idle");
  }, []);
  const unsupported = useCallback(async () => {
    setErrorCode("recording-unsupported");
    setStatus("error");
  }, []);

  return {
    availability: "file" as const,
    clearError,
    errorCode,
    errorMessage: null,
    recordingDurationMs: 0,
    recordingLevels: [],
    startRecording: unsupported,
    status,
    stopRecording: () => undefined,
    transcribeFile: unsupported,
  };
}
