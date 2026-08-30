/** Adapted from AionUi Renderer components/chat/SendBox. */
import { Button, Input } from "@arco-design/web-react";
import { ArrowUp, Plus, Square } from "@icon-park/react";
import { useState } from "react";

type Props = {
  disabled?: boolean;
  loading?: boolean;
  onSend: (value: string) => void;
  onStop: () => void;
  onAttach: () => void;
};

export function AionSendBox({
  disabled,
  loading,
  onSend,
  onStop,
  onAttach,
}: Props) {
  const [input, setInput] = useState("");
  const submit = () => {
    const value = input.trim();
    if (!value || disabled) return;
    setInput("");
    onSend(value);
  };
  return (
    <div className="aion-sendbox-wrap chat-surface-fluid">
      <div className="sendbox-panel relative p-16px border-3 b bg-dialog-fill-0 b-solid rd-20px flex flex-col overflow-hidden">
        <Input.TextArea
          autoFocus
          disabled={disabled}
          spellCheck={false}
          value={input}
          placeholder="Type / for commands, @ to reference files"
          className="pl-0 pr-0 !b-none focus:shadow-none m-0 !bg-transparent !focus:bg-transparent !hover:bg-transparent lh-20px !resize-none text-14px"
          autoSize={{ minRows: 1, maxRows: 10 }}
          onChange={setInput}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        <div className="sendbox-action-row flex items-center justify-between gap-2 w-full mt-8px">
          <div className="sendbox-tools flex items-center gap-2">
            <Button
              shape="circle"
              type="secondary"
              icon={<Plus />}
              disabled={disabled}
              onClick={onAttach}
              aria-label="Attach files"
            />
            <span className="text-12px text-t-tertiary">
              Personal workspace
            </span>
          </div>
          {loading ? (
            <Button
              className="sendbox-stop-button bg-animate"
              shape="circle"
              type="secondary"
              icon={<Square theme="filled" size="13" />}
              onClick={onStop}
              aria-label="Stop"
            />
          ) : (
            <Button
              className="send-button-custom"
              shape="circle"
              type="primary"
              icon={<ArrowUp theme="outline" size="17" />}
              disabled={disabled || !input.trim()}
              onClick={submit}
              aria-label="Send"
            />
          )}
        </div>
      </div>
    </div>
  );
}
