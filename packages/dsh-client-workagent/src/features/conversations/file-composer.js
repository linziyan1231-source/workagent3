import {
  fileReferenceParts,
  fileReferenceLabel,
} from "@workagent/contracts/file-reference";

export function isComposerImage(name) {
  return /\.(?:png|jpe?g|gif|webp|avif|bmp)$/i.test(name);
}

// Route file gestures to the adjacent composer, including page-wide drops.
export function bindComposerFiles(input, upload, disabled) {
  const form = input?.closest("form");
  if (!form) return () => {};
  input.dataset.composerFiles = "true";
  const paste = (event) => {
    const files = [...(event.clipboardData?.files || [])];
    if (!files.length) return;
    event.preventDefault();
    if (!disabled) void upload(files);
  };
  const route = (event) => {
    if (!Array.from(event.dataTransfer?.types || []).includes("Files")) return;
    if (
      event.target.closest?.(
        ".workagent-file-manager, .workagent-file-browser, .workagent-collab-files",
      )
    )
      return;
    const targetForm = event.target.closest?.("form");
    const surface = document.querySelector(".workagent-overlay") || document;
    if (!surface.contains(form)) return;
    if (
      targetForm
        ? targetForm !== form
        : surface.querySelector('[data-composer-files="true"]') !== input
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    event.dataTransfer.dropEffect = disabled ? "none" : "copy";
    form.classList.toggle(
      "is-file-dragging",
      event.type !== "drop" && !disabled,
    );
    if (event.type === "drop" && !disabled)
      void upload([...event.dataTransfer.files]);
  };
  const leave = (event) => {
    if (!event.relatedTarget || !form.contains(event.relatedTarget))
      form.classList.remove("is-file-dragging");
  };
  form.addEventListener("paste", paste);
  for (const name of ["drop", "dragenter", "dragover"])
    document.addEventListener(name, route, true);
  document.addEventListener("dragleave", leave, true);
  document.addEventListener("dragend", leave, true);
  return () => {
    delete input.dataset.composerFiles;
    form.classList.remove("is-file-dragging");
    form.removeEventListener("paste", paste);
    for (const name of ["drop", "dragenter", "dragover"])
      document.removeEventListener(name, route, true);
    document.removeEventListener("dragleave", leave, true);
    document.removeEventListener("dragend", leave, true);
  };
}

export function composerText(root) {
  if (root.childNodes.length === 1 && root.firstChild.nodeName === "BR")
    return "";
  let text = "";
  for (const node of root.childNodes) {
    if (node.nodeType === 3) text += node.textContent;
    else if (node.dataset?.fileReference) text += node.dataset.fileReference;
    else if (node.nodeName === "BR") text += "\n";
    else {
      const block = /^(DIV|P)$/.test(node.nodeName);
      if (block && node.previousSibling) text += "\n";
      text +=
        block &&
        node.childNodes.length === 1 &&
        node.firstChild.nodeName === "BR"
          ? ""
          : composerText(node);
    }
  }
  return text;
}

export function createFileComposer({ React, fileURL, openFile }) {
  const h = React.createElement;
  function fragment(value, workspaceId) {
    const result = document.createDocumentFragment();
    for (const part of fileReferenceParts(value)) {
      if (!part.reference) {
        result.append(document.createTextNode(part.text));
        continue;
      }
      const reference = part.reference;
      const chip = document.createElement("span");
      chip.className = "workagent-file-reference";
      chip.contentEditable = "false";
      chip.dataset.fileReference = part.text;
      chip.dataset.workspaceId = reference.workspaceId || workspaceId || "";
      chip.title = reference.path;
      const link = document.createElement("a");
      link.href = fileURL(
        chip.dataset.workspaceId,
        reference.path,
        true,
        reference.fileId,
        true,
      );
      link.setAttribute("aria-label", `预览 ${reference.name}`);
      link.textContent = `📄${reference.name}`;
      if (isComposerImage(reference.name)) {
        chip.classList.add("workagent-image-reference");
        const image = document.createElement("img");
        image.src = link.href;
        image.alt = reference.name;
        image.draggable = false;
        image.addEventListener(
          "error",
          () => {
            chip.classList.remove("workagent-image-reference");
            link.textContent = `📄${reference.name}`;
          },
          { once: true },
        );
        link.replaceChildren(image);
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.tabIndex = -1;
      remove.setAttribute("aria-label", `移除引用 ${reference.name}`);
      remove.textContent = "×";
      chip.append(link, remove);
      result.append(chip);
    }
    return result;
  }
  return function FileComposer({
    value = "",
    onChange,
    onKeyDown,
    workspaceId,
    disabled,
    autoFocus,
    placeholder,
    className = "",
    ...props
  }) {
    const ref = React.useRef(null);
    const savedRange = React.useRef(null);
    const change = React.useRef(onChange);
    change.current = onChange;
    const history = React.useRef({
      current: value,
      past: [],
      future: [],
      group: null,
      time: 0,
    });
    function record(next, group = null) {
      const state = history.current;
      if (next === state.current) return;
      if (!group || group !== state.group || Date.now() - state.time > 750) {
        state.past.push(state.current);
        if (state.past.length > 100) state.past.shift();
      }
      state.current = next;
      state.future = [];
      state.group = group;
      state.time = Date.now();
    }
    const changed = (group) => {
      const next = composerText(ref.current);
      record(next, group);
      change.current?.({ target: { value: next } });
    };
    function undo(redo = false) {
      const state = history.current;
      const from = redo ? state.future : state.past;
      if (!from.length) return;
      (redo ? state.past : state.future).push(state.current);
      state.current = from.pop();
      state.group = null;
      ref.current.replaceChildren(fragment(state.current, workspaceId));
      select(end());
      remember();
      change.current?.({ target: { value: state.current } });
    }
    function selection() {
      const selected = window.getSelection();
      return selected.rangeCount && ref.current.contains(selected.anchorNode)
        ? selected.getRangeAt(0)
        : null;
    }
    function remember() {
      const range = selection();
      if (range) savedRange.current = range.cloneRange();
    }
    function select(range) {
      const selected = window.getSelection();
      selected.removeAllRanges();
      selected.addRange(range);
    }
    function end() {
      const range = document.createRange();
      range.selectNodeContents(ref.current);
      range.collapse(false);
      return range;
    }
    function insert(text) {
      const editor = ref.current;
      editor.focus();
      const range =
        savedRange.current &&
        editor.contains(savedRange.current.commonAncestorContainer)
          ? savedRange.current
          : end();
      select(range);
      const content = fragment(text, workspaceId);
      const last = content.lastChild;
      range.deleteContents();
      range.insertNode(content);
      if (last) range.setStartAfter(last);
      range.collapse(true);
      select(range);
      remember();
      changed();
    }
    React.useLayoutEffect(() => {
      const editor = ref.current;
      if (history.current.current !== value) {
        if (!value)
          history.current = {
            current: value,
            past: [],
            future: [],
            group: null,
            time: 0,
          };
        else record(value);
      }
      if (composerText(editor) !== value) {
        const active = document.activeElement === editor;
        editor.replaceChildren(fragment(value, workspaceId));
        savedRange.current = null;
        if (active) select(end());
      }
      editor.dataset.empty = String(!value);
    }, [value, workspaceId]);
    React.useEffect(() => {
      const editor = ref.current;
      editor.workagentInsertReference = insert;
      const before = (event) => {
        if (["historyUndo", "historyRedo"].includes(event.inputType)) {
          event.preventDefault();
          undo(event.inputType === "historyRedo");
        }
      };
      editor.addEventListener("beforeinput", before);
      return () => {
        delete editor.workagentInsertReference;
        editor.removeEventListener("beforeinput", before);
      };
    });
    React.useEffect(() => {
      if (autoFocus) ref.current.focus();
    }, []);
    return h("div", {
      ...props,
      ref,
      className: `workagent-composer-input ${className}`,
      role: "textbox",
      "aria-multiline": true,
      "aria-disabled": !!disabled,
      contentEditable: !disabled,
      suppressContentEditableWarning: true,
      "data-placeholder": placeholder,
      onInput: (event) => {
        remember();
        changed(event.nativeEvent.inputType);
      },
      onBlur: remember,
      onKeyUp: remember,
      onMouseUp: remember,
      onClick: (event) => {
        const chip = event.target.closest("[data-file-reference]");
        if (!chip) return;
        event.preventDefault();
        if (event.target.closest("button")) {
          const range = document.createRange();
          range.selectNode(chip);
          select(range);
          range.deleteContents();
          ref.current.focus();
          remember();
          changed();
        } else
          openFile({
            ...fileReferenceParts(chip.dataset.fileReference)[0].reference,
            workspaceId: chip.dataset.workspaceId,
          });
      },
      onKeyDown: (event) => {
        if (
          !event.nativeEvent.isComposing &&
          (event.ctrlKey || event.metaKey) &&
          ["z", "y"].includes(event.key.toLowerCase())
        ) {
          event.preventDefault();
          undo(event.shiftKey || event.key.toLowerCase() === "y");
          return;
        }
        if (
          !event.nativeEvent.isComposing &&
          ["Backspace", "Delete"].includes(event.key)
        ) {
          const range = selection();
          if (range?.collapsed) {
            const node = range.startContainer;
            const back = event.key === "Backspace";
            const neighbor =
              node.nodeType === 3
                ? back && range.startOffset === 0
                  ? node.previousSibling
                  : !back && range.startOffset === node.length
                    ? node.nextSibling
                    : null
                : node.childNodes[range.startOffset + (back ? -1 : 0)];
            if (neighbor?.dataset?.fileReference) {
              event.preventDefault();
              range.selectNode(neighbor);
              select(range);
              range.deleteContents();
              remember();
              changed();
              return;
            }
          }
        }
        onKeyDown?.(event);
      },
      onPaste: (event) => {
        if (event.clipboardData.files.length) return;
        event.preventDefault();
        remember();
        insert(
          event.clipboardData.getData("application/x-workagent-draft") ||
            event.clipboardData.getData("text/plain"),
        );
      },
      onCopy: (event) => {
        const range = selection();
        if (!range || range.collapsed) return;
        const text = composerText(range.cloneContents());
        event.preventDefault();
        event.clipboardData.setData("application/x-workagent-draft", text);
        event.clipboardData.setData("text/plain", fileReferenceLabel(text));
      },
      onCut: (event) => {
        const range = selection();
        if (!range || range.collapsed) return;
        const text = composerText(range.cloneContents());
        event.preventDefault();
        event.clipboardData.setData("application/x-workagent-draft", text);
        event.clipboardData.setData("text/plain", fileReferenceLabel(text));
        range.deleteContents();
        remember();
        changed();
      },
    });
  };
}
