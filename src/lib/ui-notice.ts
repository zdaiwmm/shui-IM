/** Shared controls report transient feedback through the app's existing toast. */
export function uiNotice(root:HTMLElement,message:string):void {
  if(message)root.dispatchEvent(new CustomEvent('quiet-room:notice',{bubbles:true,detail:message}));
}

/** Legacy forms still own empty error anchors; presentation is centralized here. */
export function mountSubmissionFeedback(root: HTMLElement): () => void {
  const observer = new MutationObserver(records => {
    const candidates = new Set<HTMLElement>();
    for (const record of records) {
      const target = record.target instanceof HTMLElement ? record.target : record.target.parentElement;
      const anchor = target?.closest<HTMLElement>('.form-error[role="alert"], .archive-inline-error');
      if (anchor) candidates.add(anchor);
      for (const node of record.addedNodes) if (node instanceof HTMLElement) {
        if (node.matches('.form-error[role="alert"], .archive-inline-error')) candidates.add(node);
        node.querySelectorAll<HTMLElement>('.form-error[role="alert"], .archive-inline-error').forEach(item => candidates.add(item));
      }
    }
    for (const anchor of candidates) {
      if (!root.contains(anchor) || anchor.closest('[inert], .local-page-outgoing, .page-transition-outgoing')) continue;
      const message = anchor.textContent?.trim();
      if (message) { anchor.textContent = ''; uiNotice(root, message); }
    }
  });
  observer.observe(root, {subtree:true,childList:true,characterData:true});
  return () => observer.disconnect();
}
