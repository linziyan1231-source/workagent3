import { useEffect, useRef, useState } from "react";

// Autofill has no universal origin flag. Only reveal text whose entire value
// came through a known manual edit; unknown fills and partial edits stay masked.
export function usePasswordVisibility(
  value: string,
  onValueChange: (value: string) => void,
) {
  const inputRef = useRef<HTMLInputElement>(null);
  const manualValue = useRef<string | null>(null);
  const [canReveal, setCanReveal] = useState(false);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const input = inputRef.current!;
    let manualEdit = false;
    const beforeInput = (event: InputEvent) => {
      const replacesAll =
        input.selectionStart === 0 && input.selectionEnd === input.value.length;
      manualEdit =
        event.isTrusted &&
        /^(insertText|insertCompositionText|insertFromComposition|insertFromPaste|insertFromDrop|deleteContentBackward|deleteContentForward|deleteByCut)$/.test(
          event.inputType,
        ) &&
        (!input.value || input.value === manualValue.current || replacesAll);
    };
    const changed = (event: Event) => {
      onValueChange(input.value);
      const manual =
        manualEdit && event.isTrusted && !input.matches(":autofill");
      manualValue.current = manual ? input.value : null;
      manualEdit = false;
      setCanReveal(manual && !!input.value);
      if (!manual || !input.value) setVisible(false);
    };
    const autofilled = (event: AnimationEvent) => {
      if (event.animationName !== "login-autofill") return;
      onValueChange(input.value);
      manualValue.current = null;
      setCanReveal(false);
      setVisible(false);
    };
    input.addEventListener("beforeinput", beforeInput);
    input.addEventListener("input", changed);
    input.addEventListener("animationstart", autofilled);
    return () => {
      input.removeEventListener("beforeinput", beforeInput);
      input.removeEventListener("input", changed);
      input.removeEventListener("animationstart", autofilled);
    };
  }, [onValueChange]);

  useEffect(() => {
    if (!value) {
      manualValue.current = null;
      setCanReveal(false);
      setVisible(false);
    }
  }, [value]);

  const toggle = () => {
    const input = inputRef.current!;
    if (
      canReveal &&
      input.value === manualValue.current &&
      !input.matches(":autofill")
    ) {
      setVisible(!visible);
    } else {
      setCanReveal(false);
      setVisible(false);
    }
  };
  return { inputRef, canReveal, visible, toggle };
}
