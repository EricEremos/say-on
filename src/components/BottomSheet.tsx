import { useEffect, useRef, type ReactNode } from "react";

const FOCUSABLE = "input:not([disabled]), button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])";

/**
 * Modal bottom sheet from the approved lobby board: dimmed page, grab handle, close mark.
 * Focus moves into the sheet, stays there (Tab cycles), Escape closes, and focus returns to
 * the control that opened it.
 */
export const BottomSheet = ({ titleId, title, icon = null, onClose, children }: Readonly<{
  titleId: string;
  title: string;
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}>) => {
  const panel = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; }, [onClose]);

  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = (): HTMLElement[] => Array.from(panel.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
    (focusables().find((element) => element.tagName === "INPUT") ?? focusables()[0])?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      if (opener !== null && document.body.contains(opener)) opener.focus();
    };
  }, []);

  return (
    <div className="say-sheet">
      <div className="say-sheet__scrim" aria-hidden="true" onClick={() => close.current()} />
      <div ref={panel} className="say-sheet__panel" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <span className="say-sheet__handle" aria-hidden="true" />
        <button className="say-sheet__close" type="button" aria-label="닫기" onClick={() => close.current()}>
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
        </button>
        {icon}
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  );
};
