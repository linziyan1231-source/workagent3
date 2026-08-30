import type { ComponentType, ReactNode } from "react";

declare const SendBox: ComponentType<{
  value?: string;
  onChange?: (value: string) => void;
  onSend: (message: string) => Promise<void>;
  onStop?: () => Promise<void>;
  disabled?: boolean;
  sendDisabled?: boolean;
  loading?: boolean;
  className?: string;
  tools?: ReactNode;
  rightTools?: ReactNode;
  prefix?: ReactNode;
  placeholder?: string;
  defaultMultiLine?: boolean;
  lockMultiLine?: boolean;
  bottomHint?: ReactNode;
  onMobilePlusClick?: () => void;
}>;

export default SendBox;
