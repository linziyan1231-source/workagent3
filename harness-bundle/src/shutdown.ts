// A process upgrade must not wait forever for an unresponsive engine or remote
// notification service. Unfinished executions remain journaled for recovery.
export async function waitForShutdown(
  work: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer!);
  }
}
