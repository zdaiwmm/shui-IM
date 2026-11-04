import assert from 'node:assert/strict';

export async function verifyScrollingGradient(page) {
  const gradient=await page.evaluate(()=>{
    const {app}=fixture,list=document.querySelector('#message-list');
    const bubble=[...list.querySelectorAll('.outgoing .text-bubble')].find(node => {
      const rect=node.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < innerHeight;
    });
    if (!bubble) throw Error('Expected a visible outgoing text bubble');
    bubble.dataset.gradientProbe='true';
    const before=bubble.style.getPropertyValue('--bubble-gradient-offset');
    app.chatViewportMotion.touchStart();app.chatViewportMotion.move();
    if(app.usesListScrolling)list.scrollTop=Math.max(0,list.scrollTop-50);else window.scrollBy(0,-50);
    app.scheduleChatScroll();return before;
  });
  await page.clock.runFor(16);
  assert.notEqual(await page.locator('[data-gradient-probe]').evaluate(n=>n.style.getPropertyValue('--bubble-gradient-offset')),gradient,'Gradient must change during the active scroll gesture');
  await page.evaluate(()=>fixture.app.chatViewportMotion.suspend());
}
