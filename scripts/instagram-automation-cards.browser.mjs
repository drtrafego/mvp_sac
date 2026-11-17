// UI real com respostas sintéticas locais. Não usa sessão, Meta nem Instagram.
// PLAYWRIGHT_PATH=/tmp/sac-playwright/node_modules/playwright-core/index.mjs node scripts/instagram-automation-cards.browser.mjs
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
const require = createRequire(resolve('package.json'))
const { build } = createRequire(require.resolve('tsx'))('esbuild')
const tailwind = require('@tailwindcss/postcss')
const postcss = createRequire(require.resolve('@tailwindcss/postcss'))('postcss')
const { chromium } = await import(pathToFileURL(process.env.PLAYWRIGHT_PATH || '/tmp/sac-playwright/node_modules/playwright-core/index.mjs').href)
const output = '/tmp/story-cards-browser'
await mkdir(output,{recursive:true})
const bundle = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import Page from './src/app/(dashboard)/comentarios-instagram/page'; createRoot(document.getElementById('app')).render(<Page/>);`, resolveDir:process.cwd(), loader:'tsx' }, bundle:true, write:false, platform:'browser', jsx:'automatic', define:{'process.env.NODE_ENV':'"development"'}, tsconfig:'tsconfig.json' })
const css = await postcss([tailwind()]).process(await readFile('src/app/globals.css','utf8'),{from:resolve('src/app/globals.css')})
const period={from:'2026-11-01T00:00:00.000Z',to:'2026-11-16T23:59:59.000Z'}
const common={id:7,name:'Material para quem escreve QUERO',matchType:'contains',dmMessage:'Olá! Aqui está o material que você pediu.',isActive:true,createdAt:'2026-11-16T12:00:00Z'}
const comment={...common,keywords:'QUERO, LINK',triggerType:'comment',totalTriggered:999}
const story={...common,name:'Material na resposta ao Story',keywords:['QUERO','LINK'],storyId:null,mode:'send',enabledAt:null}
const totals={disparos:12,enviados:8,falhas:1,ignorados:2,ultimoDisparo:'2026-11-16T12:00:00Z'}
const requests=[]
let saveError=false
const server=createServer(async (req,res)=>{
  const url=new URL(req.url,'http://localhost')
  const body=[]; for await (const chunk of req) body.push(chunk)
  requests.push({path:url.pathname,query:url.search,method:req.method,body:Buffer.concat(body).toString()})
  if(url.pathname==='/bundle.js'){res.setHeader('Content-Type','application/javascript');res.end(bundle.outputFiles[0].text);return}
  if(url.pathname==='/styles.css'){res.setHeader('Content-Type','text/css');res.end(css.css);return}
  if(!url.pathname.startsWith('/api/')){res.setHeader('Content-Type','text/html');res.end('<!doctype html><html lang="pt-BR" class="dark"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/styles.css"></head><body class="bg-surface-base text-fg"><main id="app" style="padding:20px;max-width:1400px;margin:auto"></main><script src="/bundle.js"></script></body></html>');return}
  res.setHeader('Content-Type','application/json')
  let data={}
  if(url.pathname==='/api/comment-automations')data={automations:[comment]}
  else if(url.pathname==='/api/story-automations' && req.method==='GET')data={automations:[story]}
  else if(url.pathname==='/api/instagram-tag-rules')data={rules:[]}
  else if(url.pathname==='/api/story-automations/stories')data={stories:[]}
  else if(url.pathname==='/api/instagram-automations/metrics')data={period,automations:['comment','story'].map(type=>({type,id:7,totais:totals}))}
  else if(url.pathname.endsWith('/logs')) {
    const page=Number(url.searchParams.get('page')||1)
    data={page,limit:10,total:11,logs:[{id:page,createdAt:'2026-11-16T12:00:00Z',commenterUsername:page===1?'pessoa_teste':null,senderId:'****1234',status:page===1?'skipped':'observed',reason:page===1?'Limite de envios atingido.':'Modo teste: nenhum envio realizado.'}]}
  } else if(req.method==='POST' && saveError){res.statusCode=400;data={error:'Informe a mensagem do Direct.'}}
  res.end(JSON.stringify(data))
})
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium-browser',headless:true,args:['--no-sandbox','--disable-dev-shm-usage']})
const page=await browser.newPage({timezoneId:'America/Sao_Paulo'})
const errors=[];page.on('pageerror',error=>errors.push(error.message))
try{
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.getByRole('button',{name:'Regras de Automação (2)',exact:true}).waitFor()
  const cards=page.locator('[data-automation-type]')
  assert.equal(await cards.count(),2)
  const storyCard=page.locator('[data-automation-type="story"]')
  const commentCard=page.locator('[data-automation-type="comment"]')
  assert.equal(await storyCard.getByText('STORY',{exact:true}).count(),1)
  assert.equal(await commentCard.getByText('STORY',{exact:true}).count(),0)
  assert.equal(requests.filter(r=>r.path.endsWith('/logs')).length,0)
  assert.equal(await page.getByText('Histórico recente',{exact:true}).count(),0)
  for(const width of [390,768,1440]){
    await page.setViewportSize({width,height:1000})
    for(const theme of ['dark','light']){
      await page.evaluate(theme=>{document.documentElement.className=theme;document.documentElement.dataset.theme=theme},theme)
      await cards.first().scrollIntoViewIfNeeded()
      await page.screenshot({path:`${output}/cards-${width}-${theme}.png`,fullPage:true})
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),`Sem overflow em ${width}/${theme}`)
      // Contraste do selo, cores computadas dos tokens de cada tema.
      const contrast=await storyCard.getByText('STORY',{exact:true}).evaluate(el=>{
        const style=getComputedStyle(el)
        const luminance=color=>{const rgb=color.match(/[\d.]+/g).slice(0,3).map(v=>Number(v)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return rgb[0]*.2126+rgb[1]*.7152+rgb[2]*.0722}
        const a=luminance(style.color),b=luminance(style.backgroundColor)
        return (Math.max(a,b)+.05)/(Math.min(a,b)+.05)
      })
      assert.ok(contrast>=4.5,`Selo AA ${theme}: ${contrast}`)
    }
  }
  await storyCard.getByRole('button',{name:'Ver histórico'}).click()
  await storyCard.getByText('Ignorado: Limite de envios atingido.').waitFor()
  await storyCard.getByRole('button',{name:'Próxima'}).click()
  await storyCard.getByText('Teste: Modo teste: nenhum envio realizado.').waitFor()
  await page.getByRole('button',{name:'Histórico de Disparos',exact:true}).click()
  await page.getByText('Ignorado: Limite de envios atingido.').first().waitFor()
  assert.equal(await page.getByText('Ignorado: Limite de envios atingido.').count(),2)
  assert.equal(await page.getByText('STORY',{exact:true}).count(),1)
  await page.getByRole('button',{name:'Resposta ao Story: criar nova regra',exact:true}).click()
  const dialog=page.getByRole('dialog')
  await dialog.waitFor()
  assert.equal(await page.getByLabel('Nome',{exact:true}).evaluate(el=>el===document.activeElement),true)
  await page.mouse.click(3,3)
  assert.equal(await dialog.evaluate(el=>el.contains(document.activeElement)),true,'Clique no fundo mantém foco real')
  await dialog.getByRole('button',{name:'Salvar',exact:true}).focus()
  await page.keyboard.press('Tab')
  assert.equal(await dialog.getByRole('button',{name:'Fechar'}).evaluate(el=>el===document.activeElement),true)
  await page.keyboard.press('Shift+Tab')
  assert.equal(await dialog.getByRole('button',{name:'Salvar',exact:true}).evaluate(el=>el===document.activeElement),true)
  saveError=true
  await dialog.getByRole('button',{name:'Salvar',exact:true}).click()
  await dialog.getByRole('alert').waitFor()
  assert.equal(await dialog.getAttribute('aria-describedby'),await dialog.getByRole('alert').getAttribute('id'))
  await page.keyboard.press('Escape')
  assert.equal(await page.getByRole('dialog').count(),0)
  assert.equal(await page.getByRole('button',{name:'Resposta ao Story: criar nova regra',exact:true}).evaluate(el=>el===document.activeElement),true)
  assert.deepEqual(errors,[])
  await writeFile(`${output}/result.json`,JSON.stringify({ok:true,captures:6,widths:[390,768,1440],themes:['dark','light'],errors,requests},null,2))
  console.log('PASS: cards, 6 capturas, selo AA, métricas, paginação, aba mista e teclado/fundo/alerta reais.')
}finally{await browser.close();await new Promise(resolve=>server.close(resolve))}
