import { releaseDisclosureAnchorReserve, restoreDisclosureAnchor } from './disclosure';
import { createReadingAnchor, type ReadingAnchor } from '../lib/transcript-reading-position';
import { noteProgrammaticScroll } from '../ui/motion/programmatic-scroll';

export interface ViewportReadingAnchor { element: HTMLElement; top: number; viewportTop: number; node?: Text; text?: string; scopeAttribute?: ReadingAnchor['attribute']; scopeId?: string; messageId?: string; reparentable?: boolean }

function textTop(node: Text): number {
  const range = document.createRange();
  range.selectNodeContents(node);
  return range.getBoundingClientRect().top;
}

/** Keep several reading fragments: an async report may legitimately move into its task. */
export function captureViewportReadingAnchors(root: HTMLElement): ViewportReadingAnchor[] {
  const bounds = root.getBoundingClientRect();
  const anchors: ViewportReadingAnchor[] = [];
  const seen = new Set<Text>();
  for (const fraction of [0.4, 0.6, 0.8, 0.2, 0.95]) {
    let captured = false;
    for (const minimum of [30, 1]) {
      for (const offset of [-120, 0, 120]) {
        const range = document.caretRangeFromPoint(bounds.left + bounds.width / 2 + offset, bounds.top + bounds.height * fraction);
        const node = range?.startContainer;
        if (!(node instanceof Text) || seen.has(node) || !root.contains(node) || (node.textContent?.trim().length ?? 0) < minimum || node.parentElement?.closest('[hidden], [inert]')) continue;
        const element = node.parentElement!;
        const scope = element.closest<HTMLElement>('[data-presentation-key], [data-message-id], [data-minimap-id]');
        const scopeAttribute = scope?.hasAttribute('data-presentation-key') ? 'data-presentation-key' : scope?.hasAttribute('data-minimap-id') ? 'data-minimap-id' : scope ? 'data-message-id' : undefined;
        anchors.push({ element, node, text: node.textContent!, top: textTop(node), viewportTop: bounds.top, scopeAttribute, scopeId: scopeAttribute ? scope!.getAttribute(scopeAttribute)! : undefined, messageId: element.closest<HTMLElement>('[data-message-id]')?.dataset.messageId, reparentable: !!element.closest('.native-task-delivery, .task-delivery') });
        seen.add(node); captured = true; break;
      }
      if (captured) break;
    }
  }
  if (anchors.length) return anchors.sort((left, right) => Number(left.reparentable) - Number(right.reparentable) || Number((left.text?.trim().length ?? 0) < 30) - Number((right.text?.trim().length ?? 0) < 30));
  const candidates = Array.from(root.querySelectorAll<HTMLElement>('[data-presentation-key], [data-message-id], [data-minimap-id], [role=treeitem]')).filter(element => {
    const rect = element.getBoundingClientRect();
    return !element.closest('[hidden], [inert]') && rect.height > 0 && rect.bottom > bounds.top && rect.top < bounds.bottom;
  });
  const element = candidates.find(element => element.hasAttribute('data-presentation-key')) ?? candidates[0];
  if (!element) return [];
  const scopeAttribute = element.hasAttribute('data-presentation-key') ? 'data-presentation-key' : element.hasAttribute('data-minimap-id') ? 'data-minimap-id' : element.hasAttribute('data-message-id') ? 'data-message-id' : undefined;
  return [{ element, top: element.getBoundingClientRect().top, viewportTop: bounds.top, scopeAttribute, scopeId: scopeAttribute ? element.getAttribute(scopeAttribute)! : undefined, messageId: element.closest<HTMLElement>('[data-message-id]')?.dataset.messageId }];
}

/** A completed partial turn may replace DOM nodes while retaining its journal text. */
export function restoreViewportReadingAnchor(root: HTMLElement, anchor: ViewportReadingAnchor): HTMLElement | null {
  const targetTop = root.getBoundingClientRect().top + anchor.top - anchor.viewportTop;
  if (!anchor.text && anchor.scopeAttribute && anchor.scopeId) {
    const element = root.querySelector<HTMLElement>(`[${anchor.scopeAttribute}="${CSS.escape(anchor.scopeId)}"]`);
    if (element && !element.closest('[hidden], [inert]')) {
      root.scrollTop += element.getBoundingClientRect().top - targetTop;
      noteProgrammaticScroll(root);
      anchor.element = element;
      return element;
    }
    return null;
  }
  let node = anchor.node;
  if (anchor.text && (!node?.isConnected || !root.contains(node) || node.textContent !== anchor.text || node.parentElement?.closest('[hidden], [inert]'))) {
    const scope = anchor.scopeAttribute && anchor.scopeId ? root.querySelector<HTMLElement>(`[${anchor.scopeAttribute}="${CSS.escape(anchor.scopeId)}"]`) : null;
    const search = (parent: HTMLElement): Text | undefined => {
      const walker = document.createTreeWalker(parent, NodeFilter.SHOW_TEXT);
      let nearest: Text | undefined, distance = Infinity;
      for (let candidate = walker.nextNode(); candidate; candidate = walker.nextNode()) {
        if (candidate.textContent !== anchor.text || candidate.parentElement?.closest('[hidden], [inert]')) continue;
        const next = Math.abs(textTop(candidate as Text) - targetTop);
        if (next < distance) { nearest = candidate as Text; distance = next; }
      }
      return nearest;
    };
    node = scope ? search(scope) : undefined;
    node ??= search(root);
  }
  if (node?.isConnected && root.contains(node) && !node.parentElement?.closest('[hidden], [inert]')) {
    const element = node.parentElement!;
    const content = root.querySelector<HTMLElement>('.thread-content, .subagent-transcript-list, .history-explorer-rows');
    if (content) {
      const delta = textTop(node) - targetTop;
      const top = element.getBoundingClientRect().top - root.getBoundingClientRect().top - delta;
      restoreDisclosureAnchor(root, content, { element, top, automatic: true });
      releaseDisclosureAnchorReserve(root, content);
    } else root.scrollTop += textTop(node) - targetTop;
    noteProgrammaticScroll(root);
    anchor.node = node; anchor.element = node.parentElement!;
    return anchor.element;
  }
  if (!anchor.text && anchor.element.isConnected && root.contains(anchor.element) && !anchor.element.closest('[hidden], [inert]')) { root.scrollTop += anchor.element.getBoundingClientRect().top - targetTop; noteProgrammaticScroll(root); return anchor.element; }
  return null;
}

/** Transfer the restored fragment's canonical identity, not a message-ID alias. */
export function viewportReadingAnchorHandoff(root: HTMLElement, anchor: ViewportReadingAnchor): ReadingAnchor | undefined {
  const scope = anchor.element.closest<HTMLElement>('[data-presentation-key], [data-message-id], [data-minimap-id]');
  if (!scope || !root.contains(scope) || scope.closest('[hidden], [inert]')) return undefined;
  return createReadingAnchor({ presentationKey: scope.dataset.presentationKey, messageId: scope.dataset.messageId ?? anchor.messageId, minimapId: scope.dataset.minimapId, turnId: scope.closest<HTMLElement>('[data-minimap-id]')?.dataset.minimapId }, scope.getBoundingClientRect().top - root.getBoundingClientRect().top);
}
