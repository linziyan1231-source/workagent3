import { Switch } from "@arco-design/web-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { requestJson } from "../api/http";

type SpeechCapability = {
  enabled: boolean;
};

export default function ManagedVoiceInputSection() {
  const { t } = useTranslation();
  const [enabled, setEnabled] = useState(false);

  useEffect(() => {
    let active = true;
    void requestJson<SpeechCapability>("/api/speech/capability")
      .then((capability) => {
        if (active) setEnabled(capability.enabled);
      })
      .catch(() => {
        if (active) setEnabled(false);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <div className="px-[12px] md:px-[32px] py-[24px] bg-2 rd-12px md:rd-16px border border-border-2">
      <div className="flex items-center justify-between gap-12px mb-8px">
        <div className="flex flex-col gap-4px">
          <span className="text-14px text-t-primary">
            {t("settings.speechToText")}
          </span>
          <span className="text-13px text-t-secondary">
            {t("settings.speechToTextDescription")}
          </span>
        </div>
        <Switch checked={enabled} disabled />
      </div>
    </div>
  );
}
