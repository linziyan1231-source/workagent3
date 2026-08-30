import { Typography } from "@arco-design/web-react";
import type { PropsWithChildren, ReactNode } from "react";

export function SettingsSection({
  title,
  description,
  children,
}: PropsWithChildren<{ title: string; description?: string }>) {
  return (
    <div className="flex flex-col w-full max-w-620px px-8px">
      <Typography.Title heading={5} className="!mt-0 !mb-4px text-t-primary">
        {title}
      </Typography.Title>
      {description && (
        <Typography.Text className="text-13px text-t-secondary mb-20px">
          {description}
        </Typography.Text>
      )}
      <div className="flex flex-col gap-12px">{children}</div>
    </div>
  );
}

export function SettingsRow({ title, detail, action }: { title: string; detail: string; action?: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-20px px-16px py-14px rd-10px bg-fill-1">
      <div className="min-w-0">
        <div className="text-14px font-500 text-t-primary">{title}</div>
        <div className="text-12px text-t-secondary mt-3px">{detail}</div>
      </div>
      {action}
    </div>
  );
}
