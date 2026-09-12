import { Select } from "../../ui/elements.js";
import React from "react";
import { createElement as h } from "react";

const FONT_SIZE_KEY = "workagent.font-size";

const fontSizes = [
  ["13", "紧凑"],
  ["14", "标准"],
  ["16", "大号"],
  ["18", "特大"],
];

function readFontSize() {
  const value = localStorage.getItem(FONT_SIZE_KEY);
  return fontSizes.some(([size]) => size === value) ? value : "13";
}

function applyFontSize(value) {
  document.documentElement.dataset.workagentFontSize = value;
  document.documentElement.style.setProperty(
    "--workagent-font-scale",
    String(Number(value) / 14),
  );
}

export function installTypography() {
  const root = document.documentElement;
  const style = root.style;
  const previous = style.getPropertyValue("--workagent-font-scale");
  const previousSize = root.dataset.workagentFontSize;
  applyFontSize(readFontSize());
  return () => {
    style.setProperty("--workagent-font-scale", previous);
    if (previousSize === undefined) delete root.dataset.workagentFontSize;
    else root.dataset.workagentFontSize = previousSize;
  };
}

function TypographySettings() {
  const [size, setSize] = React.useState(readFontSize);
  return h(
    "section",
    { className: "workagent-typography", "aria-label": "字体" },
    h(
      "div",
      null,
      h("strong", null, "字体大小"),
      h("p", null, "调整界面和对话文字，自动保存。"),
    ),
    h(Select, {
      "aria-label": "字体大小",
      value: size,
      options: fontSizes,
      onChange: (event) => {
        const value = event.target.value;
        localStorage.setItem(FONT_SIZE_KEY, value);
        applyFontSize(value);
        setSize(value);
      },
    }),
  );
}

export { readFontSize, applyFontSize, TypographySettings };
