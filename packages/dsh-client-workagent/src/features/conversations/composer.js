import { workbench } from "../content/index.js";
import { Icon } from "../../ui/icons.js";
import React from "react";
import { createElement as h } from "react";

function submitComposerOnEnter(event, submit) {
  if (
    event.key !== "Enter" ||
    event.shiftKey ||
    event.nativeEvent.isComposing ||
    event.nativeEvent.keyCode === 229
  )
    return;
  event.preventDefault();
  if (submit) submit(event);
  (
    event.currentTarget.form || event.currentTarget.closest("form")
  )?.requestSubmit();
}

function ComposerInput(props) {
  return h(workbench.FileComposer, props);
}

function ComposerForm({ children, className, showSettings = true, ...props }) {
  const [expanded, setExpanded] = React.useState(false);
  const formRef = React.useRef(null);
  React.useLayoutEffect(() => {
    const form = formRef.current;
    const container = form.parentElement;
    const measure = () =>
      container.style.setProperty(
        "--workagent-composer-height",
        `${form.getBoundingClientRect().height}px`,
      );
    const observer = new ResizeObserver(measure);
    observer.observe(form);
    measure();
    const viewport = window.visualViewport;
    const keyboard = () => {
      const offset =
        viewport &&
        window.matchMedia("(max-width: 760px)").matches &&
        viewport.scale === 1 &&
        form.contains(document.activeElement)
          ? Math.max(
              0,
              window.innerHeight - viewport.height - viewport.offsetTop,
            )
          : 0;
      container.style.setProperty("--workagent-keyboard-offset", `${offset}px`);
    };
    viewport?.addEventListener("resize", keyboard);
    viewport?.addEventListener("scroll", keyboard);
    form.addEventListener("focusin", keyboard);
    return () => {
      observer.disconnect();
      container.style.removeProperty("--workagent-composer-height");
      viewport?.removeEventListener("resize", keyboard);
      viewport?.removeEventListener("scroll", keyboard);
      form.removeEventListener("focusin", keyboard);
      container.style.removeProperty("--workagent-keyboard-offset");
    };
  }, []);
  return h(
    "form",
    {
      ...props,
      ref: formRef,
      className: `${className} workagent-compact-composer`,
      "data-options-open": expanded,
    },
    children,
    showSettings
      ? h(
          "button",
          {
            type: "button",
            className: "workagent-composer-settings",
            "aria-label": "模型与权限设置",
            "aria-expanded": expanded,
            // Focusing this button must not move it between pointer down/up.
            onPointerDown: (event) => {
              if (event.button === 0) event.preventDefault();
            },
            onClick: () => setExpanded(!expanded),
          },
          h(Icon, { name: "settings", size: 18 }),
        )
      : null,
  );
}

export { submitComposerOnEnter, ComposerInput, ComposerForm };
