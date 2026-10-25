import assert from 'node:assert/strict';
export async function verifyReliabilitySurfaces(page) {
  await page.evaluate(()=>fixture.fresh(0));
  const cards=await page.evaluate(async()=>{
    const {app,session}=fixture, originalFetch=fetch, apply=app.applyRoomStateQueued;
    const own={...session.vault.members[0],deviceName:'本机 iPhone',createdAt:new Date().toISOString()};
    const members=[own,...Array.from({length:2},(_,index)=>({...own,deviceId:crypto.randomUUID(),deviceName:`另一台设备 ${index+1}`}))];
    window.fetch=(input,options)=>String(input).endsWith('/device-links')?Promise.resolve(new Response(JSON.stringify({state:{},links:[]}),{headers:{'Content-Type':'application/json'}})):originalFetch(input,options);
    app.applyRoomStateQueued=async()=>{};
    const result=[];
    try {
      for(let count=1;count<=3;count++) {
        session.vault.members=members.slice(0,count); await app.renderDeviceManager();
        result.push([...document.querySelectorAll('.device-card')].map(card=>{
          const style=getComputedStyle(card),rect=card.getBoundingClientRect();
          return {corners:[style.borderTopLeftRadius,style.borderTopRightRadius,style.borderBottomLeftRadius,style.borderBottomRightRadius],line:style.borderTopWidth,width:rect.width};
        }));
      }
      app.renderDeviceDetail(members[1]);
      return {result,roomField:document.querySelector('.device-detail-lines').textContent.includes('所属密室')};
    } finally { window.fetch=originalFetch;app.applyRoomStateQueued=apply;session.vault.members=[own]; }
  });
  assert.equal(cards.roomField,false);
  cards.result.forEach((rows,index)=>{assert.equal(rows.length,index+1);rows.forEach(row=>{assert.deepEqual(row.corners,['12px','12px','12px','12px']);assert.equal(row.line,'0px');assert.ok(row.width>0);});});
  for(const scheme of ['light','dark']) {
    await page.emulateMedia({colorScheme:scheme,reducedMotion:'reduce'});
    const themes=await page.evaluate(async()=> (await import('/src/lib/appearance.ts')).THEMES.map(theme=>theme.id));
    for(const theme of themes) {
      await page.evaluate(async({scheme,theme})=>{
        const appearance=await import('/src/lib/appearance.ts');appearance.saveColorScheme(localStorage,scheme);appearance.saveTheme(localStorage,theme);appearance.applyAppearance();
        document.querySelector('#app').replaceChildren();
        (await import('/src/lib/space-drawer.ts')).mountSpaceDrawer(document.querySelector('#app'),{spaces:[],currentRoom:'',signal:new AbortController().signal,initialSettings:true,actions:[],select:async()=>{},create:async()=>{},rename:async()=>{},styleChanged:()=>{},closed:()=>{}});
        await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      },{scheme,theme});
      const colors=await page.evaluate(()=>{
        const probe=document.createElement('span');document.body.append(probe);
        const sample=variable=>{probe.style.color=`var(${variable})`;return getComputedStyle(probe).color;};
        const result={panel:getComputedStyle(document.querySelector('.is-settings-sheet .space-drawer')).backgroundColor,top:sample('--chrome-top-surface'),bottom:sample('--chrome-bottom-surface')};probe.remove();return result;
      });
      assert.equal(colors.top,colors.panel,JSON.stringify({scheme,theme,colors}));assert.equal(colors.bottom,colors.panel,JSON.stringify({scheme,theme,colors}));
    }
  }
  console.log('PASS reliability surfaces: real device manager/detail, 1–3 independent cards and settings top/bottom in 18 theme variants');
}
