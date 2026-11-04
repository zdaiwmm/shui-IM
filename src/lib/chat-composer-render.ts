/** At minimum height the editor itself can detect wrapping. A taller editor
 * needs the mirror to detect shrinking, including during IME and transitions. */
export function resizeComposerOnInput(
  textarea: HTMLTextAreaElement,
  event: Event,
  activeComposition: boolean,
  heightAnimating: boolean,
  resize: (animate: boolean, deferNativeShrink: boolean, composing: boolean) => void,
): void {
  const composing = event instanceof InputEvent && event.isComposing;
  if (activeComposition || composing || heightAnimating
    || textarea.offsetHeight !== parseFloat(getComputedStyle(textarea).minHeight)
    || textarea.scrollHeight > textarea.clientHeight) {
    resize(true, true, composing);
  }
}

// A send can finish after a new reply has been selected.
export function shouldClearSentReply(sent: object | null, current: object | null): boolean {
  return Boolean(sent) && sent === current;
}
