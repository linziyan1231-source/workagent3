import { Button } from "@arco-design/web-react";
import { Plus } from "@icon-park/react";
import SendBox from "@renderer/components/chat/SendBox";

type Props = {
  disabled?: boolean;
  loading?: boolean;
  onSend: (value: string) => void | Promise<void>;
  onStop: () => void | Promise<void>;
  onAttach: () => void;
};

/**
 * WorkAgent3 transport adapter around the original AionUi Renderer SendBox.
 * The component tree, styles and interaction logic remain owned by AionUi.
 */
export function AionSendBox({
  disabled,
  loading,
  onSend,
  onStop,
  onAttach,
}: Props) {
  const attachmentButton = (
    <Button
      shape="circle"
      type="secondary"
      icon={<Plus theme="outline" size="16" />}
      disabled={disabled}
      onClick={onAttach}
      aria-label="Attach files"
    />
  );

  return (
    <div className="aion-sendbox-wrap chat-surface-fluid">
      <SendBox
        disabled={disabled}
        loading={loading}
        onSend={async (value) => {
          await onSend(value);
        }}
        onStop={async () => {
          await onStop();
        }}
        tools={attachmentButton}
        onMobilePlusClick={onAttach}
      />
    </div>
  );
}
