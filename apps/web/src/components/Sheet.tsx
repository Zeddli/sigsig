import { useEffect, useId, useRef, type ReactNode } from 'react';

/** A side sheet the visitor opens (connect, vote, keeper preview). Esc and the backdrop close it; focus moves in. */
export function Sheet({ open, onClose, title, children, footer, wide = false }: {
  open: boolean; onClose(): void; title: string; children: ReactNode; footer?: ReactNode; wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    document.body.classList.add('s-locked');
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.classList.remove('s-locked');
      prev?.focus?.();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="s-sheet" role="presentation">
      <button type="button" className="s-sheet__scrim" aria-label="Close" tabIndex={-1} onClick={onClose} />
      <div className={`s-sheet__panel${wide ? ' s-sheet__panel--wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={id} ref={ref} tabIndex={-1}>
        <div className="s-sheet__head">
          <h2 id={id} className="s-sheet__title">{title}</h2>
          <button type="button" className="s-iconbtn" onClick={onClose} aria-label="Close">
            <svg viewBox="0 0 18 18" aria-hidden="true"><path d="M4 4l10 10M14 4L4 14" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
          </button>
        </div>
        <div className="s-sheet__body">{children}</div>
        {footer && <div className="s-sheet__foot">{footer}</div>}
      </div>
    </div>
  );
}
