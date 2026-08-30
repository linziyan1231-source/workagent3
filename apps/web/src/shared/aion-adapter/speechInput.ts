export function appendSpeechTranscript(previous: string, transcript: string) {
  return previous ? `${previous} ${transcript}` : transcript;
}
