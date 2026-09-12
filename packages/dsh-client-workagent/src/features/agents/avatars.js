export async function readAssistantAvatar(file) {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type))
    throw new Error("请选择 PNG、JPG、WebP 或 GIF 图片");
  if (file.size > 5 * 1024 * 1024) throw new Error("请选择不超过 5 MB 的图片");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 128;
    const edge = Math.min(image.naturalWidth, image.naturalHeight);
    canvas
      .getContext("2d")
      .drawImage(
        image,
        (image.naturalWidth - edge) / 2,
        (image.naturalHeight - edge) / 2,
        edge,
        edge,
        0,
        0,
        128,
        128,
      );
    const result = canvas.toDataURL("image/webp", 0.85);
    if (result.length > 65_536)
      throw new Error("图片内容过于复杂，请换一张图片");
    return result;
  } catch (error) {
    throw new Error(
      error.message?.startsWith("图片内容")
        ? error.message
        : "无法读取图片，请换一张图片",
    );
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function createAssistantAvatars({
  React,
  EngineMark,
  request,
  apiRoot,
}) {
  const h = React.createElement;
  const choices = [
    "✨",
    "🤖",
    "🦊",
    "🐼",
    "🐱",
    "🦉",
    "🎨",
    "💡",
    "🌿",
    "🚀",
    "📚",
    "💻",
  ];
  const colors = [
    "var(--workagent-avatar-lilac)",
    "var(--workagent-avatar-mint)",
    "var(--workagent-avatar-peach)",
    "var(--workagent-avatar-sky)",
    "var(--workagent-avatar-rose)",
    "var(--workagent-avatar-cream)",
  ];
  let presets = new Map();
  let loading;
  let loaded = false;
  const listeners = new Set();
  const refresh = () => {
    if (loading) return loading;
    loading = request(`${apiRoot}/presets`)
      .then((rows) => {
        presets = new Map(rows.map((row) => [row.id, row]));
        loaded = true;
        for (const listener of listeners) listener();
      })
      .catch(() => {
        /* Existing session snapshots remain usable offline. */
      })
      .finally(() => {
        loading = null;
      });
    return loading;
  };
  const subscribe = (listener) => {
    if (!listeners.size)
      window.addEventListener("workagent:presets-changed", refresh);
    listeners.add(listener);
    if (!loaded) void refresh();
    return () => {
      listeners.delete(listener);
      if (!listeners.size) {
        window.removeEventListener("workagent:presets-changed", refresh);
        loaded = false;
      }
    };
  };
  function AssistantAvatar({ preset, size }) {
    const avatar = preset?.avatar;
    const [failed, setFailed] = React.useState(null);
    const style = {
      ...(size ? { width: size, height: size } : {}),
      overflow: "hidden",
      fontSize: size ? size * 0.48 : "0.85em",
    };
    const image =
      avatar &&
      /^(https?:\/\/|\/(?!\/)|data:image\/(png|jpeg|webp|gif);base64,)/i.test(
        avatar,
      );
    if (image && failed !== avatar)
      return h("img", {
        className: "workagent-engine-mark workagent-assistant-avatar",
        style: { ...style, objectFit: "cover", background: "transparent" },
        src: avatar,
        alt: "",
        referrerPolicy: "no-referrer",
        onError: () => setFailed(avatar),
      });
    const builtinEngine = [
      "builtin-codex",
      "builtin-kimi",
      "builtin-general",
    ].includes(preset?.id);
    if (!avatar && (builtinEngine || !preset?.name))
      return h(EngineMark, { engine: preset?.engine || "harness" });
    const name = preset?.name || "助手";
    const text = avatar?.startsWith("emoji:")
      ? avatar.slice(6, 22)
      : preset?.id === "builtin-puxin-butler"
        ? "✨"
        : Array.from(name.trim())[0];
    const color = colors[(name.codePointAt(0) || 0) % colors.length];
    return h(
      "span",
      {
        className: "workagent-engine-mark workagent-assistant-avatar",
        "aria-hidden": true,
        style: {
          ...style,
          background: color,
          color: "var(--workagent-avatar-ink)",
          fontWeight: 600,
        },
      },
      text,
    );
  }
  function SessionAvatar({ session }) {
    const rows = React.useSyncExternalStore(subscribe, () => presets);
    const snapshot = session?.preset?.resolvedSnapshot;
    const id = session?.preset?.presetId;
    const preset =
      rows.get(id) ||
      snapshot ||
      rows.get(
        `builtin-${session?.engine === "harness" ? "general" : session?.engine}`,
      );
    return h(AssistantAvatar, {
      preset: preset || { engine: session?.engine },
    });
  }
  function AvatarPicker({
    preset,
    value,
    onChange,
    disabled = false,
    onBusyChange,
  }) {
    const [busy, setBusy] = React.useState(false);
    React.useEffect(() => {
      onBusyChange?.(busy);
    }, [busy, onBusyChange]);
    const [error, setError] = React.useState("");
    const input = React.useRef();
    const change = async (next) => {
      setBusy(true);
      setError("");
      try {
        await onChange(next);
      } catch (error) {
        setError(error.message);
      } finally {
        setBusy(false);
      }
    };
    return h(
      "div",
      {
        className: "workagent-avatar-picker",
        style: { display: "grid", gap: 10 },
      },
      h(
        "div",
        {
          style: {
            display: "flex",
            gap: 12,
            alignItems: "center",
            flexWrap: "wrap",
          },
        },
        h(AssistantAvatar, { preset: { ...preset, avatar: value }, size: 48 }),
        h(
          "button",
          {
            type: "button",
            className: "workagent-button",
            disabled: busy || disabled,
            onClick: () => input.current.click(),
          },
          busy ? "正在处理…" : "上传头像",
        ),
        h(
          "button",
          {
            type: "button",
            className: "workagent-button",
            disabled: busy || disabled || !value,
            onClick: () => change(null),
          },
          "恢复默认",
        ),
        h("input", {
          ref: input,
          type: "file",
          accept: "image/png,image/jpeg,image/webp,image/gif",
          "aria-label": "上传助手头像",
          hidden: true,
          onChange: async (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            setBusy(true);
            setError("");
            try {
              await onChange(await readAssistantAvatar(file));
            } catch (error) {
              setError(error.message);
            } finally {
              setBusy(false);
            }
          },
        }),
      ),
      h(
        "div",
        {
          role: "group",
          "aria-label": "预设头像",
          style: { display: "flex", gap: 6, flexWrap: "wrap" },
        },
        ...choices.map((emoji) =>
          h(
            "button",
            {
              key: emoji,
              type: "button",
              className: "workagent-button",
              "aria-label": `使用${emoji}头像`,
              "aria-pressed": value === `emoji:${emoji}`,
              disabled: busy || disabled,
              onClick: () => change(`emoji:${emoji}`),
              style: {
                padding: 8,
                background:
                  value === `emoji:${emoji}`
                    ? "var(--workagent-avatar-selected)"
                    : undefined,
              },
            },
            emoji,
          ),
        ),
      ),
      h(
        "small",
        { className: "workagent-muted" },
        "支持 5 MB 以内的图片，自动居中裁为方形；GIF 使用静态画面。",
      ),
      error
        ? h("p", { role: "alert", className: "workagent-error" }, error)
        : null,
    );
  }
  function AvatarField({ preset, onBusyChange }) {
    const [value, setValue] = React.useState(preset?.avatar || null);
    return h(
      "div",
      null,
      h("div", null, "头像"),
      h("input", { type: "hidden", name: "avatar", value: value || "" }),
      h(AvatarPicker, {
        preset: preset || { name: "新助手", source: "user" },
        value,
        onChange: setValue,
        onBusyChange,
      }),
    );
  }
  return { AssistantAvatar, SessionAvatar, AvatarPicker, AvatarField };
}
