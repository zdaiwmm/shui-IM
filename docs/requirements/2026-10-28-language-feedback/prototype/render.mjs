import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
const output=process.argv[2];
if(!output)throw new Error('Provide an absolute output directory');
const browser=await chromium.launch({channel:'chrome',headless:true});
const page=await browser.newPage({viewport:{width:1440,height:1000},deviceScaleFactor:2});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
for(const [view,theme] of [['mobile','light'],['mobile','dark'],['states','light'],['admin','light'],['admin','dark'],['flow','light']]){
 await page.goto(pathToFileURL(path.resolve('docs/requirements/2026-10-28-language-feedback/prototype/index.html')).href+`?view=${view}&theme=${theme}`);
 await page.evaluate(()=>document.fonts.ready);
 const root=page.locator('#root > div');
 const overflow=await page.locator('.content').evaluateAll(els=>els.map(x=>({height:x.clientHeight,scroll:x.scrollHeight,width:x.clientWidth,scrollWidth:x.scrollWidth})));
 await root.screenshot({path:path.join(output,`${view}-${theme}.png`)});
 console.log(JSON.stringify({view,theme,overflow}));
}
if(errors.length)throw new Error(errors.join('\n'));
await browser.close();
