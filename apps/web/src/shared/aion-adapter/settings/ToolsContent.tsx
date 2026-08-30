import { SettingsRow, SettingsSection } from "./SettingsSection";
export default function ToolsContent() {
  return <SettingsSection title="Tools" description="Tools are provisioned by your administrator."><SettingsRow title="Workspace files" detail="Available through the WorkAgent3 HTTP client port" /></SettingsSection>;
}
