const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const roots = [path.resolve(__dirname,'../firmware/miniprogram-latest')]
function load(root,name,services) {
 const calls=[];let definition
 const wx={showToast(){},stopPullDownRefresh(){},setNavigationBarTitle(){},pageScrollTo(o){calls.push({method:'scroll',...o})}}
 for(const method of ['navigateTo','switchTab'])wx[method]=o=>{calls.push({method,...o});if(o.success)o.success()}
 const filename=path.join(root,'pages',name,'index.js')
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{Page(d){definition=d},wx,console,setTimeout,clearTimeout,require(id){return id==='../../services/index'?services:require(path.resolve(path.dirname(filename),id))}},{filename})
 const page={...definition,data:JSON.parse(JSON.stringify(definition.data)),setData(p,done){for(const [k,v]of Object.entries(p)){const keys=k.split('.');if(keys.length===2)this.data[keys[0]][keys[1]]=v;else this.data[k]=v}if(done)done()}}
 return {page,calls}
}
function servicesFor(root){const data=require(path.join(root,'services/mock-data'));return {reports:{getLatest:async()=>({...data.latestReport}),getEvents:async()=>[],getSevenNightTrend:async()=>data.sevenNightTrend,getFeedback:async()=>null},ai:{getOverview:async()=>null}}}
for(const root of roots){const name=root.endsWith('miniprogram-latest')?'integration':'demo'
 test(name+': event details request the report night rather than unscoped events',async()=>{
  const services=servicesFor(root);const report=load(root,'report',services);report.page.data.report={id:'night-A',date:'8 月 31 日'};report.page.openEvents()
  assert.match(report.calls[0].url,/nightId=night-A/)
  let requested;services.reports.getEvents=async value=>{requested=value;return []}
  const events=load(root,'events',services);await events.page.onLoad({nightId:'night-A',date:'8 月 31 日'});assert.equal(requested.nightId,'night-A');assert.equal(events.page.data.sourceLabel,'8 月 31 日')
 })
 test(name+': feedback entry scrolls to the questions and identifies its date',async()=>{
  const services=servicesFor(root);const report=load(root,'report',services);report.page.openFeedback();assert.match(report.calls[0].url,/focus=feedback/)
  const trends=load(root,'trends',services);trends.page.onLoad({focus:'feedback'});await trends.page.load();assert.ok(trends.calls.some(c=>c.method==='scroll'&&c.selector==='#morning-feedback'));assert.ok(trends.page.data.currentNightDate)
 })
 test(name+': unsaved feedback survives reload of the same night and resets for another',async()=>{
  const services=servicesFor(root);const trends=load(root,'trends',services);await trends.page.load();trends.page.chooseBoolean({currentTarget:{dataset:{key:'awakened',value:'true'}}});await trends.page.load();assert.equal(trends.page.data.feedback.awakened,true)
  const original=await services.reports.getLatest();services.reports.getLatest=async()=>({...original,id:'night-new'});await trends.page.load();assert.equal(trends.page.data.feedback.awakened,null)
 })
}
test('integration: AI source return requests the selected night and rejects a different night',async()=>{
 const root=roots[0],services=servicesFor(root);const detail=load(root,'ai-detail',services);detail.page.data.interpretation={kind:'single-night',nightId:'night-old',interpretationId:'old-ai',sourceDate:'2026-08-20'};detail.page.openSleepRecord()
 let requested;const original=await services.reports.getLatest();services.reports.getLatest=async value=>{requested=value;return {...original,id:'night-new'}}
 const report=load(root,'report',services);await report.page.onShow();await new Promise(setImmediate);assert.equal(requested.nightId,'night-old');assert.equal(report.page.data.phase,'source-unavailable');assert.equal(report.page.data.report,null)
})
test('integration: an undated or seven-night source never substitutes the latest night',async()=>{
 const root=roots[0],services=servicesFor(root);let called=0;services.reports.getLatest=async()=>{called++;return null};const detail=load(root,'ai-detail',services);detail.page.data.interpretation={kind:'seven-night',interpretationId:'week-old',periodStart:'2026-08-14',periodEnd:'2026-08-20'};detail.page.openSleepRecord();const report=load(root,'report',services);await report.page.onShow();await new Promise(setImmediate);assert.equal(called,0);assert.equal(report.page.data.phase,'source-unavailable')
})

test('integration: a weekly view never opens a single-night interpretation while AI refreshes', async () => {
 const root=roots[0], services=servicesFor(root)
 const report=await services.reports.getLatest()
 services.reports.getLatest=async()=>({...report,aiInterpretation:{interpretationId:'single-current'}})
 services.ai.getOverview=()=>new Promise(()=>{})
 const view=load(root,'report',services)
 view.page.data.scope='week'
 await view.page.load()
 assert.equal(view.page.data.activeInterpretation,null)
})

test('a failed earlier navigation cannot clear a later selected source', () => {
 const source = require(path.join(roots[0], 'domain/sleep-source'))
 const earlier = source.rememberSleepSource({ nightId: 'night-earlier' })
 source.rememberSleepSource({ nightId: 'night-later' })
 source.clearSleepSource(earlier)
 assert.equal(source.takeSleepSource().nightId, 'night-later')
})
