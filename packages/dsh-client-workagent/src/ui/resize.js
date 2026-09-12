import React from "react";
import { createElement as h } from "react";

function ResizeHandle({
  orientation,
  value,
  onChange,
  measure,
  label,
  min,
  max,
  className = "workagent-file-resizer",
}) {
  const start = React.useRef(null);
  const vertical = orientation === "vertical";
  const finish = () => {
    start.current = null;
    document.body.classList.remove("workagent-resizing");
  };
  React.useEffect(
    () => () => {
      if (start.current) finish();
    },
    [],
  );
  const releasePointer = (event) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return h("div", {
    className: `${className} ${vertical ? "is-vertical" : "is-horizontal"}`,
    role: "separator",
    tabIndex: 0,
    "aria-orientation": orientation,
    "aria-label": label || (vertical ? "调整文件栏宽度" : "调整预览区高度"),
    "aria-valuenow": Math.round(value),
    "aria-valuemin": min,
    "aria-valuemax": max,
    onPointerDown: (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      start.current = measure(event);
      event.currentTarget.setPointerCapture(event.pointerId);
      document.body.classList.add("workagent-resizing");
    },
    onPointerMove: (event) => {
      if (start.current) onChange(start.current(event));
    },
    onLostPointerCapture: finish,
    onPointerUp: releasePointer,
    onPointerCancel: releasePointer,
    onKeyDown: (event) => {
      const direction = {
        ArrowLeft: 1,
        ArrowRight: -1,
        ArrowUp: -1,
        ArrowDown: 1,
      }[event.key];
      if (
        direction &&
        (vertical
          ? event.key === "ArrowLeft" || event.key === "ArrowRight"
          : event.key === "ArrowUp" || event.key === "ArrowDown")
      ) {
        event.preventDefault();
        onChange(value + direction * (vertical ? 24 : 5));
      }
    },
  });
}

export { ResizeHandle };
