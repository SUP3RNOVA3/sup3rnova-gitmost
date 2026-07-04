// Client-local execCommand copy fallback (previously imported from
// @docmost/editor-ext). It lives here so the ubiquitous useClipboard / CopyButton
// path does not pull in the editor-ext barrel — and with it the whole TipTap
// engine — through the eager startup graph. Behavior is identical to the
// editor-ext helper it replaces.
export function execCommandCopy(text: string): void {
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.left = "-9999px";
  textarea.style.top = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}
