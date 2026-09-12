import React from "react";
import { createElement as h } from "react";
import { Button } from "./elements.js";
import { Icon } from "./icons.js";

const focusable =
  'button:not(:disabled),input:not(:disabled):not([type="hidden"]),select:not(:disabled),textarea:not(:disabled),a[href],summary,[contenteditable]:not([contenteditable="false"]),[tabindex]:not([tabindex="-1"])';
const openDialogs = [];

export function Dialog({
  title,
  children,
  onClose,
  size = "default",
  className = "",
  closeDisabled = false,
  as = "section",
  role = "dialog",
  ...props
}) {
  const ref = React.useRef(null);
  const hostRef = React.useRef(null);
  const previousFocus = React.useRef(
    typeof document === "undefined" ? null : document.activeElement,
  );
  const close = React.useRef({ onClose, closeDisabled });
  close.current = { onClose, closeDisabled };
  const titleId = React.useId();
  React.useEffect(() => {
    const previous = previousFocus.current;
    const surface = ref.current;
    const host = hostRef.current;
    openDialogs.push(surface);
    surface.parentElement.style.zIndex = String(4000 + openDialogs.length);
    const controls = () =>
      [...surface.querySelectorAll(focusable)].filter((node) => {
        if (
          node.tabIndex < 0 ||
          node.matches(":disabled") ||
          node.closest("[hidden],[inert]")
        )
          return false;
        for (
          let parent = node;
          parent && parent !== surface;
          parent = parent.parentElement
        ) {
          const style = getComputedStyle(parent);
          if (
            style.display === "none" ||
            style.visibility === "hidden" ||
            style.visibility === "collapse"
          )
            return false;
          if (
            parent.matches("details:not([open])") &&
            !parent.querySelector(":scope > summary")?.contains(node)
          )
            return false;
        }
        return true;
      });
    // Native top-layer placement escapes sidebar/page stacking contexts.
    // The attribute fallback also permits rendering in non-layout test DOMs.
    if (host.showModal) host.showModal();
    else host.setAttribute("open", "");
    {
      const nodes = controls();
      (
        nodes.find(
          (node) =>
            node.hasAttribute("data-dialog-autofocus") ||
            node.hasAttribute("autofocus"),
        ) ||
        nodes.find((node) =>
          node.matches('input,textarea,[contenteditable="true"],select'),
        ) ||
        nodes[0] ||
        surface
      ).focus();
    }
    const key = (event) => {
      if (openDialogs.at(-1) !== surface) return;
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!close.current.closeDisabled) close.current.onClose();
      } else if (event.key === "Tab") {
        const nodes = controls();
        const first = nodes[0];
        const last = nodes.at(-1);
        if (!first) {
          event.preventDefault();
          surface.focus();
        } else if (
          event.shiftKey &&
          (document.activeElement === first ||
            !surface.contains(document.activeElement))
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            !surface.contains(document.activeElement))
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("keydown", key, true);
      openDialogs.splice(openDialogs.indexOf(surface), 1);
      if (host.close && host.open) host.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return h(
    "dialog",
    {
      ref: hostRef,
      role: "presentation",
      className: "workagent-dialog-backdrop",
      onCancel: (event) => event.preventDefault(),
      onMouseDown: (event) => {
        if (event.target === event.currentTarget && !closeDisabled) {
          event.preventDefault();
          onClose();
        }
      },
    },
    h(
      as,
      {
        ...props,
        ref,
        role,
        "aria-modal": true,
        "aria-labelledby": props["aria-label"] ? undefined : titleId,
        "data-workagent-dialog": "",
        "data-size": size,
        tabIndex: -1,
        className: ["workagent-dialog", "workagent-dialog-surface", className]
          .filter(Boolean)
          .join(" "),
      },
      h(
        "header",
        { className: "workagent-dialog-header" },
        h("h2", { id: titleId }, title),
        h(
          Button,
          {
            className: "workagent-dialog-close",
            "aria-label": "关闭",
            disabled: closeDisabled,
            onClick: onClose,
          },
          h(Icon, { name: "close", size: 18 }),
        ),
      ),
      children,
    ),
  );
}

export function ActionList({ children, className = "" }) {
  return h(
    "div",
    {
      className: ["workagent-action-list", className].filter(Boolean).join(" "),
    },
    children,
  );
}

export function useConfirm() {
  const [request, setRequest] = React.useState(null);
  const pending = React.useRef(null);
  React.useEffect(() => () => pending.current?.(false), []);
  const finish = React.useCallback((value) => {
    pending.current?.(value);
    pending.current = null;
    setRequest(null);
  }, []);
  const confirm = React.useCallback(
    (options) =>
      new Promise((resolve) => {
        pending.current?.(false);
        pending.current = resolve;
        setRequest(
          typeof options === "string" ? { description: options } : options,
        );
      }),
    [],
  );
  const confirmation = request
    ? h(
        Dialog,
        {
          title: request.title || "确认操作",
          role: "alertdialog",
          onClose: () => finish(false),
        },
        h("p", null, request.description),
        h(
          "div",
          { className: "workagent-dialog-actions" },
          h(
            Button,
            { autoFocus: true, onClick: () => finish(false) },
            request.cancelLabel || "取消",
          ),
          h(
            Button,
            {
              variant: request.danger ? "danger" : "primary",
              onClick: () => finish(true),
            },
            request.confirmLabel || "确认",
          ),
        ),
      )
    : null;
  return { confirm, confirmation };
}
