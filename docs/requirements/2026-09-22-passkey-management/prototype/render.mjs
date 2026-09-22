import {chromium} from 'playwright';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs/promises';
import path from 'node:path';
const output=process.argv[2];if(!output)throw Error('Usage: node render.mjs /absolute/output-directory');
await fs.mkdir(output,{recursive:true});
const browser=await chromium.launch({headless:true});
const page=await browser.newPage({viewport:{width:1360,height:1000},deviceScaleFactor:1});
const failures=[];page.on('pageerror',e=>failures.push(e.message));
const base=new URL('index.html',import.meta.url).href;
for(let i=1;i<=5;i++){
  await page.emulateMedia({colorScheme:i===4?'dark':'light',reducedMotion:'reduce'});
  await page.goto(`${base}?board=${i}&capture=1`);await page.evaluate(()=>document.fonts.ready);
  await page.screenshot({path:path.join(output,`board-${i}.png`),fullPage:true});
}
const dimensions=[];
for(const theme of ['light','dark']){
 await page.emulateMedia({colorScheme:theme,reducedMotion:'reduce'});
 await page.setViewportSize({width:393,height:852});
 for(let i=1;i<=21;i++){
   await page.goto(`${base}?screen=${i}`);
   await page.screenshot({path:path.join(output,`${String(i).padStart(2,'0')}-${theme}.png`)});
   dimensions.push(await page.evaluate(({i,theme})=>({screen:i,theme,overflow:document.documentElement.scrollWidth>innerWidth,buttons:[...document.querySelectorAll('button')].filter(x=>!x.disabled).length}),{i,theme}));
 }
}
await page.setViewportSize({width:320,height:568});await page.goto(`${base}?screen=10`);
await page.screenshot({path:path.join(output,'narrow-edit-dark.png')});
await page.goto(`${base}?screen=7`);await page.getByRole('button',{name:'通行密钥管理'}).click();
await page.getByRole('button',{name:'验证当前通行密钥',exact:true}).click();
await page.getByRole('button',{name:'修改名称',exact:true}).click();
await page.getByRole('button',{name:'取消',exact:true}).click();
await page.getByRole('heading',{name:'Quiet Room · 日常空间'}).waitFor();
await fs.writeFile(path.join(output,'render-check.json'),JSON.stringify({pageErrors:failures,dimensions,prototypeCancelPath:'passed',note:'Static/prototype rendering only. System verification not simulated as real authentication.'},null,2));
await browser.close();
if(failures.length||dimensions.some(x=>x.overflow))throw Error('Render check failed');
console.log('Rendered 5 boards, 42 individual screens, narrow layout; prototype cancel path passed.');
