export type CronJobStatus = "none" | "active" | "paused" | "error" | "unread";

export function CronJobIndicator(_props: {
  status: CronJobStatus;
  size?: number;
  className?: string;
}) {
  return null;
}

export function useCronJobsMap() {
  return {
    getJobStatus: (_conversationId: string): CronJobStatus => "none",
    markAsRead: (_conversationId: string) => undefined,
    setActiveConversation: (_conversationId: string | null) => undefined,
  };
}

export function useCronJobs() {
  return { jobs: [], loading: false };
}

export function CronJobManager(_props: {
  conversation_id: string;
  cron_job_id?: string;
}) {
  return null;
}
