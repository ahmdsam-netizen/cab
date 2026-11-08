let activeLocks = 0;
let previousOverflow: string | null = null;

/** Lock document scrolling until the returned release function is called. */
export function acquireDocumentScrollLock(): () => void {
  if (activeLocks === 0) {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
  activeLocks += 1;

  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeLocks = Math.max(0, activeLocks - 1);
    if (activeLocks === 0) {
      document.body.style.overflow = previousOverflow ?? '';
      previousOverflow = null;
    }
  };
}
