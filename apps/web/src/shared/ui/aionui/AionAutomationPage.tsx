/**
 * WorkAgent HTTP adaptation of the formal AionUi v2.2 ScheduledTasksPage.
 * Page structure, tokens, spacing and base components stay sourced from the
 * upstream Renderer; only the Electron cron service is replaced by a Port.
 */
import {
  Button,
  Empty,
  Form,
  Input,
  InputNumber,
  Message,
  Popconfirm,
  Select,
  Spin,
  Switch,
  Tag,
} from "@arco-design/web-react";
import { Delete, PlayOne, Plus } from "@icon-park/react";
import type {
  AutomationDefinition,
  AutomationMutation,
  AutomationRun,
  PresetDefinition,
} from "@workagent/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import AionModal from "@renderer/components/base/AionModal";
import { useLayoutContext } from "@renderer/hooks/context/LayoutContext";

export type AutomationUiPort = {
  list(): Promise<AutomationDefinition[]>;
  create(input: AutomationMutation): Promise<AutomationDefinition>;
  update(
    definition: AutomationDefinition,
    input: Partial<AutomationMutation>,
  ): Promise<AutomationDefinition>;
  remove(id: string): Promise<void>;
  run(id: string): Promise<AutomationRun>;
  history(id: string): Promise<AutomationRun[]>;
};

type Props = {
  port: AutomationUiPort;
  presets: PresetDefinition[];
  workspaceId?: string;
};

type FormValue = {
  name: string;
  input: string;
  everyMinutes: number;
  presetId: string;
};

const statusColor: Record<AutomationRun["status"], string> = {
  pending: "gray",
  running: "arcoblue",
  succeeded: "green",
  failed: "red",
  cancelled: "orange",
};

export function AionAutomationPage({ port, presets, workspaceId }: Props) {
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  const { t } = useTranslation();
  const [jobs, setJobs] = useState<AutomationDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [dialogVisible, setDialogVisible] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [history, setHistory] = useState<Record<string, AutomationRun[]>>({});
  const [form] = Form.useForm<FormValue>();

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setJobs(await port.list());
    } catch (error) {
      Message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [port]);

  useEffect(() => void refresh(), [refresh]);

  const filteredJobs = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    return query === ""
      ? jobs
      : jobs.filter((job) =>
          `${job.name} ${job.input}`.toLocaleLowerCase().includes(query),
        );
  }, [jobs, searchQuery]);

  const loadHistory = useCallback(
    async (id: string) => {
      setSelected(id);
      const runs = await port.history(id);
      setHistory((current) => ({
        ...current,
        [id]: runs,
      }));
    },
    [port],
  );

  const create = async () => {
    try {
      const value = await form.validate();
      const preset = presets.find((item) => item.id === value.presetId);
      if (preset === undefined) throw new Error("preset_not_found");
      if (workspaceId === undefined) throw new Error("workspace_not_selected");
      setSubmitting(true);
      const mutation: AutomationMutation = {
        name: value.name,
        enabled: true,
        schedule: { kind: "interval", everyMinutes: value.everyMinutes },
        presetId: preset.id,
        engine: preset.engine,
        workspaceId,
        input: value.input,
        notificationPolicy: "on_failure",
      };
      await port.create(mutation);
      setDialogVisible(false);
      form.resetFields();
      await refresh();
      Message.success(t("cron.page.createSuccess"));
    } catch (error) {
      if (error instanceof Error) Message.error(error.message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="w-full h-full min-h-0 box-border bg-1 flex flex-col overflow-hidden">
      <div
        className={
          isMobile
            ? "shrink-0 bg-1 px-16px pt-14px pb-14px"
            : "shrink-0 bg-1 px-12px pt-14px pb-14px md:px-40px md:pt-32px md:pb-16px"
        }
      >
        <div className="mx-auto w-full max-w-800px box-border">
          <div className="flex w-full flex-col gap-8px">
            <div className="flex w-full items-start justify-between gap-12px sm:gap-16px max-[520px]:flex-wrap">
              <h1
                className={`m-0 min-w-0 flex-1 font-bold text-t-primary ${isMobile ? "text-24px leading-[1.2]" : "text-28px leading-[1.15]"}`}
              >
                {t("cron.scheduledTasks")}
              </h1>
              <div className="flex items-center gap-8px">
                {!isMobile && (
                  <Input.Search
                    className="shrink-0 w-[200px] hidden md:flex"
                    placeholder={t("cron.page.searchPlaceholder")}
                    value={searchQuery}
                    onChange={setSearchQuery}
                  />
                )}
                <Button
                  type="primary"
                  icon={<Plus />}
                  disabled={
                    workspaceId === undefined ||
                    !presets.some((preset) => preset.enabled)
                  }
                  onClick={() => setDialogVisible(true)}
                >
                  {t("cron.page.newTask")}
                </Button>
              </div>
            </div>
            <p
              className={`m-0 w-full text-t-secondary ${isMobile ? "text-13px leading-20px" : "text-14px leading-22px"}`}
            >
              {t("cron.page.description")}
            </p>
          </div>
        </div>
      </div>

      <div
        className={
          isMobile
            ? "min-h-0 flex-1 overflow-y-auto px-16px pb-14px"
            : "min-h-0 flex-1 overflow-y-auto px-12px pb-24px md:px-40px md:pb-32px"
        }
      >
        <div className="mx-auto flex w-full max-w-800px box-border flex-col gap-16px">
          {loading ? (
            <div className="flex min-h-220px items-center justify-center rounded-16px border border-dashed border-border-2 bg-fill-1">
              <Spin />
            </div>
          ) : jobs.length === 0 ? (
            <div className="flex min-h-220px items-center justify-center rounded-16px border border-dashed border-border-2 bg-fill-1">
              <Empty description={t("cron.noTasks")} />
            </div>
          ) : filteredJobs.length === 0 ? (
            <div className="flex min-h-220px items-center justify-center rounded-16px border border-dashed border-border-2 bg-fill-1">
              <Empty description={t("cron.page.noSearchResults")} />
            </div>
          ) : (
            <div className="w-full">
              {filteredJobs.map((job, index) => (
                <div
                  key={job.id}
                  style={{
                    marginBottom: index === filteredJobs.length - 1 ? 0 : 12,
                  }}
                >
                  <div
                    className="group flex min-h-48px cursor-pointer items-center justify-between gap-12px rounded-12px border border-solid border-transparent bg-transparent px-12px py-6px transition-colors duration-180 hover:bg-fill-2"
                    onClick={() => void loadHistory(job.id)}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-14px leading-19px font-medium text-t-primary">
                        {job.name}
                      </div>
                      <div className="mt-1px truncate text-12px leading-16px text-t-secondary">
                        {job.schedule.kind === "interval"
                          ? `${t("cron.page.custom.every")} ${job.schedule.everyMinutes} ${t("cron.page.custom.minutes")}`
                          : `${job.schedule.timezone} · ${job.schedule.hour.toString().padStart(2, "0")}:${job.schedule.minute.toString().padStart(2, "0")}`}
                        <span className="mx-6px opacity-60">·</span>
                        {t("cron.nextRun")}：
                        {job.nextRunAt
                          ? new Date(job.nextRunAt).toLocaleString()
                          : "-"}
                      </div>
                    </div>
                    <div
                      className="flex shrink-0 items-center gap-6px"
                      onClick={(event) => event.stopPropagation()}
                    >
                      <Button
                        type="text"
                        size="small"
                        icon={<PlayOne />}
                        onClick={async () => {
                          await port.run(job.id);
                          await loadHistory(job.id);
                          Message.success(t("cron.runNowSuccess"));
                        }}
                      />
                      <Switch
                        size="small"
                        checked={job.enabled}
                        onChange={async (enabled) => {
                          const updated = await port.update(job, { enabled });
                          setJobs((current) =>
                            current.map((item) =>
                              item.id === job.id ? updated : item,
                            ),
                          );
                        }}
                      />
                      <Popconfirm
                        title={t("cron.confirmDelete")}
                        onOk={async () => {
                          await port.remove(job.id);
                          setJobs((current) =>
                            current.filter((item) => item.id !== job.id),
                          );
                        }}
                      >
                        <Button
                          type="text"
                          status="danger"
                          size="small"
                          icon={<Delete />}
                        />
                      </Popconfirm>
                    </div>
                  </div>
                  {selected === job.id && (
                    <div className="mx-12px mt-4px rounded-12px border border-solid border-border-2 bg-fill-1 px-14px py-10px">
                      <div className="mb-8px text-12px font-medium text-t-secondary">
                        {t("cron.detail.history")}
                      </div>
                      {(history[job.id] ?? []).length === 0 ? (
                        <div className="text-12px text-t-tertiary">
                          {t("cron.detail.noHistory")}
                        </div>
                      ) : (
                        (history[job.id] ?? []).map((run) => (
                          <div
                            key={run.id}
                            className="flex items-center justify-between gap-8px py-4px text-12px"
                          >
                            <span className="truncate text-t-secondary">
                              {new Date(run.scheduledFor).toLocaleString()}
                            </span>
                            <Tag color={statusColor[run.status]}>
                              {run.status}
                            </Tag>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <AionModal
        header={{ title: t("cron.page.createTask"), showClose: true }}
        visible={dialogVisible}
        onCancel={() => setDialogVisible(false)}
        onOk={create}
        confirmLoading={submitting}
        okText={t("cron.page.save")}
        cancelText={t("cron.page.cancel")}
        className="w-[min(560px,calc(100vw-32px))] max-w-560px"
        unmountOnExit
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{ everyMinutes: 30, presetId: presets[0]?.id }}
        >
          <Form.Item
            field="name"
            label={t("cron.page.form.name")}
            rules={[{ required: true }]}
          >
            <Input placeholder={t("cron.page.form.namePlaceholder")} />
          </Form.Item>
          <Form.Item
            field="presetId"
            label={t("cron.page.form.assistant")}
            rules={[{ required: true }]}
          >
            <Select>
              {presets
                .filter((preset) => preset.enabled)
                .map((preset) => (
                  <Select.Option key={preset.id} value={preset.id}>
                    {preset.name}
                  </Select.Option>
                ))}
            </Select>
          </Form.Item>
          <Form.Item
            field="input"
            label={t("cron.page.form.prompt")}
            rules={[{ required: true }]}
          >
            <Input.TextArea
              autoSize={{ minRows: 3, maxRows: 8 }}
              placeholder={t("cron.page.form.promptPlaceholder")}
            />
          </Form.Item>
          <Form.Item
            field="everyMinutes"
            label={t("cron.page.custom.every")}
            rules={[{ required: true }]}
          >
            <InputNumber
              min={1}
              max={525600}
              suffix={t("cron.page.custom.minutes")}
            />
          </Form.Item>
        </Form>
      </AionModal>
    </div>
  );
}
