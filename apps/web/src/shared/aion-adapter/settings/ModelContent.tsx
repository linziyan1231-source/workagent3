import { SettingsRow, SettingsSection } from "./SettingsSection";
export default function ModelContent() {
  return <SettingsSection title="Models" description="Models available to this employee runtime."><SettingsRow title="Harness" detail="Managed by the WorkAgent3 runtime" /></SettingsSection>;
}
