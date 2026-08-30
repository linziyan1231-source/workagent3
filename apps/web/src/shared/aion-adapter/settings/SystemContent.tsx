import { Switch } from "@arco-design/web-react";
import { SettingsRow, SettingsSection } from "./SettingsSection";
export default function SystemContent() {
  return <SettingsSection title="System"><SettingsRow title="Desktop notifications" detail="Notify when a task completes" action={<Switch disabled />} /><SettingsRow title="Language" detail="Follows your browser language" /></SettingsSection>;
}
