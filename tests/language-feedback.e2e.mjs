import assert from 'node:assert/strict';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import { privacyFixture } from './helpers/privacy-fixture.mjs';
const fixture=await privacyFixture({viewport:{width:390,height:844},isMobile:true,hasTouch:true,deviceScaleFactor:2});
const {page}=fixture;
const output=process.env.QUIET_ROOM_LANGUAGE_SCREENSHOTS;
async function capture(name){if(output){await mkdir(output,{recursive:true});await page.screenshot({path:path.join(output,name+'.png')});}}

try{
 await page.evaluate(async()=>{
  const {mountLanguage,setLanguage}=await import('/src/lib/language.ts');
  Object.defineProperty(navigator,'languages',{configurable:true,value:['ko-KR','zh-TW']});
  await mountLanguage();
 });
 assert.equal(await page.evaluate(()=>document.documentElement.lang),'zh-Hant');
 await page.evaluate(async()=>{
  const {setLanguage,mountLanguage}=await import('/src/lib/language.ts');
  await setLanguage('en');
  Object.defineProperty(navigator,'languages',{configurable:true,value:['ja-JP']});
  await mountLanguage();
 });
 assert.equal(await page.evaluate(()=>document.documentElement.lang),'en');
 await page.evaluate(async()=>{
  const {setLanguage}=await import('/src/lib/language.ts');
  Object.defineProperty(navigator,'languages',{configurable:true,value:['ko-KR']});
  await setLanguage('system');
 });
 assert.equal(await page.evaluate(()=>document.documentElement.lang),'en');
 await page.evaluate(async()=>{await(await import('/src/lib/language.ts')).setLanguage('zh-Hans');});
 await page.evaluate(async()=>{const {app}=window.fixture;app.idleLease.clear();app.renderLanguageFeedback('language');});
 assert.equal(await page.locator('[name=language]').count(),12);
 await page.locator('[name=language][value=en]').check();
 await page.waitForFunction(()=>document.documentElement.lang==='en');
 assert.equal(await page.locator('.language-feedback-content h1').textContent(),'Language');
 assert.equal(await page.evaluate(()=>localStorage.getItem('quiet-room:language')),'en');
 await capture('language-light');
 await page.locator('[name=language][value=zh-Hant]').check();
 await page.waitForFunction(()=>document.documentElement.lang==='zh-Hant');
 assert.equal(await page.locator('.language-feedback-content h1').textContent(),'語言 / Language');
 await page.locator('[name=language][value=ar]').check();
 await page.waitForFunction(()=>document.documentElement.dir==='rtl');
 const overflow=await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth);assert.equal(overflow,false);
 await capture('language-arabic');
 await page.locator('[name=language][value=en]').check();
 await page.waitForFunction(()=>document.documentElement.lang==='en');
 assert.deepEqual(await page.evaluate(async()=>{
  const {uiTemplate}=await import('/src/lib/language.ts');
  const {mountPageBacks}=await import('/src/lib/page-back.ts');
  const host=document.createElement('div');host.innerHTML=uiTemplate`<section class="gateway"><button aria-label="返回聊天">返回</button></section>`;
  document.body.append(host);mountPageBacks(host);
  const normalized=!!host.querySelector('.page-back-footer .page-back-button');host.remove();
  const {messageLocalDay}=await import('/src/lib/message-date.ts');
  return [normalized,messageLocalDay('2026-10-28T12:00:00',2026).label];
 }),[true,'October 28']);
 // Template values are private content and are never translated, even if identical to a UI label.
 assert.deepEqual(await page.evaluate(async()=>{const {uiTemplate,t}=await import('/src/lib/language.ts');return [t('设置'),uiTemplate`<p>${'设置'}</p>`];}),['Settings','<p>设置</p>']);
 await page.evaluate(()=>window.fixture.app.renderLanguageFeedback('feedback'));
 assert.equal(await page.locator('.language-feedback-content h1').textContent(),'Feedback');
 await capture('feedback-light');
 await page.evaluate(()=>document.documentElement.dataset.colorScheme='dark');await capture('feedback-dark');
 await page.evaluate(()=>document.documentElement.dataset.colorScheme='light');

 assert.equal(await page.locator('.feedback-form .hint,.privacy,.preference-note').count(),0);
 await page.locator('[type=submit]').click();
 assert.match(await page.locator('#feedback-email-error').textContent(),/valid email/);
 await page.locator('#feedback-email').fill('test@example.com');await page.locator('#feedback-message').fill('设置 <img src=x onerror=alert(1)>');
 const bodies=[];let fail=true;
 await page.route('**/api/feedback',async route=>{bodies.push(route.request().postDataJSON());await route.fulfill({status:fail?503:200,contentType:'application/json',body:JSON.stringify(fail?{code:'FAILED'}:{accepted:true})});});
 await page.locator('[type=submit]').click();
 await page.waitForFunction(()=>!document.querySelector('[type=submit]').disabled);
 assert.equal(await page.locator('#feedback-message').inputValue(),'设置 <img src=x onerror=alert(1)>');
 fail=false;await page.locator('[type=submit]').click();
 await page.waitForFunction(()=>document.querySelector('.language-feedback-content h1')?.textContent==='Feedback submitted');
 assert.equal(bodies.length,2);assert.equal(bodies[0].id,bodies[1].id);assert.equal(bodies[1].message,'设置 <img src=x onerror=alert(1)>');
 assert.deepEqual(Object.keys(bodies[1]).sort(),['email','id','message']);
 await page.evaluate(()=>window.fixture.app.renderLanguageFeedback('feedback'));
 await page.locator('#feedback-email').fill('test@example.com');await page.locator('#feedback-message').fill('private draft');
 await page.evaluate(()=>window.fixture.app.lockNow());assert.equal(await page.locator('#feedback-message').count(),0);
 assert.deepEqual(fixture.errors,[]);
 console.log('Language / feedback mobile UI passed');
}finally{await fixture.close();}
