export const modelName = (id: string) =>
  ({
    "harness-default": "通用默认模型",
    "codex-native": "Codex 原生模型",
    "kimi-native": "Kimi 原生模型",
    "speech-transcription": "语音转写",
  })[id] ?? id;
export const number = (value: number) => value.toLocaleString("zh-CN");

export const dollars = (value: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  }).format(value);
export const poolName = (pool: string) =>
  pool === "codex"
    ? "Codex / ChatGPT"
    : pool === "kimi"
      ? "Kimi"
      : "未识别服务";
