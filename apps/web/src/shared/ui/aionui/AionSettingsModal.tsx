/** Adapted from AionUi Renderer SettingsModal and SettingsSider. */
import { Modal, Switch } from "@arco-design/web-react";
import { ArrowLeft, Info, Moon, Robot, SettingTwo } from "@icon-park/react";
import { useState } from "react";

export function AionSettingsModal({
  visible,
  onClose,
}: {
  visible: boolean;
  onClose: () => void;
}) {
  const [section, setSection] = useState("general");
  return (
    <Modal
      className="aion-settings-modal"
      visible={visible}
      onCancel={onClose}
      footer={null}
      title={null}
      unmountOnExit={false}
    >
      <div className="aion-settings">
        <div className="settings-mobile-titlebar">
          <button type="button" aria-label="Back to chat" onClick={onClose}>
            <ArrowLeft size="18" />
          </button>
          <strong>WorkAgent</strong>
          <span />
        </div>
        <aside className="settings-sider">
          <h2>Settings</h2>
          <button
            className={section === "general" ? "active" : ""}
            onClick={() => setSection("general")}
          >
            <SettingTwo size="16" />
            General
          </button>
          <button
            className={section === "models" ? "active" : ""}
            onClick={() => setSection("models")}
          >
            <Robot size="16" />
            Models
          </button>
          <button
            className={section === "appearance" ? "active" : ""}
            onClick={() => setSection("appearance")}
          >
            <Moon size="16" />
            Appearance
          </button>
          <button
            className={section === "about" ? "active" : ""}
            onClick={() => setSection("about")}
          >
            <Info size="16" />
            About
          </button>
        </aside>
        <section className="settings-content">
          <h2>
            {section === "models"
              ? "Models"
              : section === "appearance"
                ? "Appearance"
                : section === "about"
                  ? "About"
                  : "General"}
          </h2>
          {section === "general" && (
            <>
              <div className="settings-row">
                <div>
                  <strong>Desktop notifications</strong>
                  <p>Notify when a task completes.</p>
                </div>
                <Switch disabled />
              </div>
              <div className="settings-row">
                <div>
                  <strong>Language</strong>
                  <p>English</p>
                </div>
              </div>
            </>
          )}
          {section === "models" && (
            <div className="settings-empty">
              <Robot size="28" />
              <strong>Runtime-managed models</strong>
              <p>Model access is configured by your administrator.</p>
            </div>
          )}
          {section === "appearance" && (
            <div className="settings-row">
              <div>
                <strong>Theme</strong>
                <p>Use the classic AionUi light appearance.</p>
              </div>
            </div>
          )}
          {section === "about" && (
            <div className="settings-empty">
              <BrandMark />
              <strong>WorkAgent 3</strong>
              <p>Web-only employee Agent workspace.</p>
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}

function BrandMark() {
  return <span className="settings-about-mark">WA</span>;
}
