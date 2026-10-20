/** Shared controls report transient feedback through the app's existing toast. */
export function uiNotice(root:HTMLElement,message:string):void {
  if(message)root.dispatchEvent(new CustomEvent('quiet-room:notice',{bubbles:true,detail:message}));
}
