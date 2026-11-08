// Install Playwright separately or set PLAYWRIGHT_MODULE to its module path.
const { default: playwright } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { chromium } = playwright;
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'cqa-browser-'));
process.env.STORAGE_DIR=dir; process.env.DATA_DIR=dir; process.env.NODE_ENV='test';
const {default:app}=await import('../server/index.js');
fs.writeFileSync(path.join(dir,'DEV.json'),JSON.stringify([{conversation_id:'browser',language:'RU',channel:'agent chat',transcript:[{timestamp:'00:01',speaker:'operator',text:'Здравствуйте! Я Айгерим.'}]}]));
app.locals.localModel={kind:'local',model:'browser-fixture',async decide({questions}){const answers=Object.fromEntries(Object.entries(questions).map(([id,q])=>[id,{choice:q.options[0].key,probabilities:{[q.options[0].key]:1},confidence:1,evidence:[0],checked_range:[]}]));return {model:'browser-fixture',operator_name:'Айгерим',answers};}};
const server=app.listen(0); await new Promise(r=>server.once('listening',r));
let browser;
try {
 browser=await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),args:['--no-sandbox']});
 const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 const base=`http://127.0.0.1:${server.address().port}`;
 page.on('dialog', dialog=>dialog.accept());
 await page.goto(base+'/#/checklists');await page.getByRole('heading',{name:'Чек-лист',exact:true}).waitFor();
 await page.locator('[data-toggle="0"]').click();await page.locator('[data-del="0"]').click();
 await page.locator('#cl-add').click();await page.locator('[data-new="yesno"]').click();
 await page.locator('[data-f=name]').fill('Новый критерий');await page.locator('[data-f=description]').fill('Проверить новый критерий');
 await page.locator('#cl-save').click();await page.locator('#cl-confirm').click();await page.getByRole('heading',{name:'Сохранена версия v2'}).waitFor();
 const versions=await (await page.request.get(base+'/api/checklists?all=1')).json();
 const replacement=versions.find(c=>c.version===2).criteria.find(c=>c.name==='Новый критерий').id;
 await page.goto(base+'/#/conv/browser?group=DEV');await page.locator('#cqa-reeval').click();
 await page.waitForURL(/[?&]ev=/);await page.locator('#crit-'+replacement).waitFor();assert.ok(await page.locator('.cqa-conv-eval').getByText('Новый критерий',{exact:true}).count());
 await page.getByRole('button',{name:'реплика 0',exact:true}).first().click();await page.locator('#msg-0.cqa-highlight').waitFor();
 const appeal=page.getByRole('heading',{name:'Подать апелляцию'}).locator('..');await appeal.locator('[name=comment]').fill('Прошу проверить');await appeal.getByRole('button',{name:'Подать апелляцию'}).click();await page.getByText('Ожидает решения проверяющего',{exact:true}).waitFor();
 await page.locator('#cqa-role').selectOption('reviewer');await page.getByText('Ожидает решения проверяющего',{exact:true}).waitFor();await page.goto(base+'/#/appeals');await page.getByRole('heading',{name:'Очередь проверяющего'}).waitFor();
 await page.locator('[name=action]').selectOption('change');await page.locator('[name=new_answer]').selectOption('no');await page.locator('[name=reason]').fill('Подтверждено транскриптом');await page.getByRole('button',{name:'Сохранить решение'}).click();await page.getByText('Апелляций нет.',{exact:true}).waitFor();
 await page.locator('#status').selectOption('resolved');await page.getByText(/Подтверждено транскриптом/).waitFor();
 await page.screenshot({path:path.join(os.tmpdir(), 'cqa-appeals.png'),fullPage:true});
 assert.deepEqual(errors,[]);console.log('PASS: editor replacement → v2 → reapply → evidence → appeal → role → decision');
} finally {await browser?.close();server.close();fs.rmSync(dir,{recursive:true,force:true});}
