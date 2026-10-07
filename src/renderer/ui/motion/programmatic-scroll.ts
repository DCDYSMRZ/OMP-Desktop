type ScrollPosition = { readonly scrollTop: number };
const positions = new WeakMap<object, number>();

/** Record the browser's actual position, not a potentially rounded request. */
export function noteProgrammaticScroll(element: ScrollPosition): void {
  positions.set(element, element.scrollTop);
}

export function clearProgrammaticScroll(element: ScrollPosition): void {
  positions.delete(element);
}

/** DOM-free: event targets need no realm-specific HTMLElement check. */
export function isProgrammaticScroll(target: unknown): boolean {
  if (target === null || typeof target !== 'object') return false;
  const position = positions.get(target);
  return position !== undefined && (target as ScrollPosition).scrollTop === position;
}
