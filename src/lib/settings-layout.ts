/** Shared Chamber settings chrome. Move existing controls, preserving their
 * listeners, form ownership and navigation; async content remains independent. */
export function mountSettingsLayout(root:HTMLElement):()=>void {
  const discover=()=>{
    const page=root.querySelector<HTMLElement>(':scope > :is(.appearance-page,.app-access-page,.notification-page,.notification-copy-page,.release-history-page,.backup-page,.device-shell:has(#device-back))');
    if(!page||page.hasAttribute('data-chamber-settings'))return;
    const header=page.querySelector<HTMLElement>(':scope > .subpage-header');
    const back=header?.querySelector<HTMLButtonElement>('button[id$="back"]')??page.querySelector<HTMLButtonElement>(':scope > .page-back-footer .page-back-button');
    if(!header||!back)return;
    page.dataset.chamberSettings='';page.classList.add('chamber-settings-page');
    const footer=page.querySelector<HTMLElement>(':scope > .page-back-footer')??document.createElement('footer');
    footer.classList.add('page-back-footer','chamber-page-footer');
    const save=header.querySelector<HTMLButtonElement>('#notification-copy-save');
    if(save){save.classList.add('primary-button');footer.append(save);}
    const existing=page.querySelector<HTMLButtonElement>('.backup-help-return');
    existing?.remove();
    back.className='text-button page-back-button';back.textContent='返回';footer.append(back);
    page.append(footer);
  };
  const observer=new MutationObserver(discover);observer.observe(root,{childList:true});discover();
  return ()=>observer.disconnect();
}
