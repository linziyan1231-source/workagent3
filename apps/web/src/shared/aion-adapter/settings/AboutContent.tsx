import { SettingsRow, SettingsSection } from "./SettingsSection";
export default function AboutContent() {
  return <SettingsSection title="WorkAgent 3" description="Personal employee agent workspace."><SettingsRow title="Renderer" detail="AionUi / WorkAgent2" /><SettingsRow title="Transport" detail="WorkAgent3 HTTP and SSE" /></SettingsSection>;
}
