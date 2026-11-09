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
function servicesFor(root){const data=require(path.join(root,'services/mock-data'));return {reports:{getLatest:async()=>({...data.latestReport}),getByNightId:async id=>id === data.latestReport.id ? {...data.latestReport} : null,getEvents:async()=>[],getSevenNightTrend:async()=>data.sevenNightTrend,getFeedback:async()=>null},ai:{getOverview:async()=>null}}}
for(const root of roots){const name=root.endsWith('miniprogram-latest')?'integration':'demo'
 test(name+': sleep data and event details use the selected night',async()=>{
  const services=servicesFor(root)
  const report=load(root,'report',services)
  await report.page.load()
  await report.page.openData()
  assert.equal(report.calls[0].url,'/pages/report-detail/index?date=2026-08-31&nightId=night-2026-08-31')
  let requested
  services.reports.getEvents=async value=>{requested=value;return []}
  const data=load(root,'report-detail',services)
  const url = new URL(report.calls[0].url, 'https://test.invalid')
  await data.page.onLoad(Object.fromEntries(url.searchParams))
  assert.equal(requested.nightId,'night-2026-08-31')
  assert.equal(data.page.data.phase,'data')
 })
 test(name+': feedback entry scrolls to the questions and identifies its date',async()=>{
  const services=servicesFor(root);const report=load(root,'report',services);await report.page.load();await report.page.openFeedback();assert.match(report.calls[0].url,/focus=feedback/)
  services.reports.getSevenNightTrend = async () => { throw new Error('feedback should not request trends') }
  const trends=load(root,'trends',services)
  trends.page.onLoad({focus:'feedback'})
  await trends.page.load()
  assert.equal(trends.page.data.phase,'data')
  assert.equal(trends.page.data.feedbackOnly,true)
  assert.ok(trends.calls.some(c=>c.method==='scroll'&&c.selector==='#morning-feedback'))
  assert.ok(trends.page.data.currentNightDate)
 })
 test(name+': unsaved feedback survives reload of the same night and resets for another',async()=>{
  const services=servicesFor(root);const trends=load(root,'trends',services);await trends.page.load();trends.page.chooseBoolean({currentTarget:{dataset:{key:'awakened',value:'true'}}});await trends.page.load();assert.equal(trends.page.data.feedback.awakened,true)
  const original=await services.reports.getLatest();services.reports.getLatest=async()=>({...original,id:'night-new'});await trends.page.load();assert.equal(trends.page.data.feedback.awakened,null)
 })
}
test('integration: AI source return requests the selected night and rejects a different night',async()=>{
 const root=roots[0],services=servicesFor(root);const detail=load(root,'ai-detail',services);detail.page.data.interpretation={kind:'single-night',nightId:'night-old',interpretationId:'old-ai',sourceDate:'2026-08-20'};detail.page.openSleepRecord()
 let requested;const original=await services.reports.getLatest();services.reports.getByNightId=async value=>{requested=value;return {...original,id:'night-new'}}
 const report=load(root,'report',services);await report.page.onShow();await new Promise(setImmediate);assert.equal(requested,'night-old');assert.equal(report.page.data.phase,'source-unavailable');assert.equal(report.page.data.report,null)
})
test('integration: AI source opens its original week without requesting the latest night',async()=>{
 const root=roots[0],services=servicesFor(root);let called=0;services.reports.getLatest=async()=>{called++;return null}
 const detail=load(root,'ai-detail',services)
 detail.page.data.interpretation={kind:'seven-night',interpretationId:'week-old',periodStart:'2026-08-14',periodEnd:'2026-08-20'}
 await detail.page.openSleepRecord()
 const report=load(root,'report',services)
 await report.page.onShow()
 await report.page.openData()
 assert.equal(called,0)
 assert.equal(report.page.data.phase,'period')
 assert.match(report.calls[0].url,/scope=week&periodStart=2026-08-14&periodEnd=2026-08-20/)
})

test('an undated AI source does not fall back to the latest night',async()=>{
 const root=roots[0],services=servicesFor(root);let called=0;services.reports.getLatest=async()=>{called++;return null}
 const detail=load(root,'ai-detail',services)
 detail.page.data.interpretation={kind:'single-night',interpretationId:'night-undated'}
 await detail.page.openSleepRecord()
 const report=load(root,'report',services)
 await report.page.onShow()
 assert.equal(called,0)
 assert.equal(report.page.data.phase,'source-unavailable')
})

test('a failed earlier navigation cannot clear a later selected source', async () => {
 const { openSleepSource, takeSleepSourceRequest } = require(path.join(roots[0], 'domain/ai-navigation'))
 let fail
 const earlier = openSleepSource({}, { switchTab(options) { fail = options.fail } }, { nightId: 'night-earlier' })
 await openSleepSource({}, { switchTab(options) { options.success() } }, { nightId: 'night-later' })
 fail()
 await earlier
 assert.equal(takeSleepSourceRequest().nightId, 'night-later')
})

test('period arrows query the adjacent date and never step past today', async () => {
 const root=roots[0], services=servicesFor(root), requests=[]
 services.reports.getByNightId=async id=>{requests.push(id);return null}
 const {page}=load(root,'report-detail',services)
 await page.onLoad({date:'2026-08-31'})
 await page.stepPeriod({currentTarget:{dataset:{direction:-1}}})
 assert.deepEqual(requests,['night-2026-08-31','night-2026-08-30'])
 await page.changeDate(page.data.maxDate)
 assert.equal(page.data.canAdvance,false)
 const count=requests.length
 await page.stepPeriod({currentTarget:{dataset:{direction:1}}})
 assert.equal(requests.length,count)
})

test('latest report preserves the exact device record ID and empty data keeps the calendar entry', async () => {
 const root=roots[0], services=servicesFor(root)
 const seed = await services.reports.getLatest()
 const nightId = '20260830_device-test'
 services.reports.getLatest = async () => ({ ...seed, id: nightId })
 const report=load(root,'report',services)
 await report.page.load()
 await report.page.openData()
 assert.equal(report.calls[0].url,'/pages/report-detail/index?date=2026-08-31&nightId=20260830_device-test')
 services.reports.getLatest = async () => null
 const empty=load(root,'report',services)
 await empty.page.load()
 await empty.page.openData()
 assert.equal(empty.calls[0].url,'/pages/report-detail/index')
})

test('quick dates keep feedback and data tied to the chosen night, even when requests finish out of order', async () => {
 const services=servicesFor(roots[0])
 const latest=await services.reports.getLatest()
 const oldNight={...latest,id:'device-08-29',sourceDate:'2026-08-29'}
 let finishEarlier
 services.reports.getByNightId=id=>id==='night-2026-08-30' ? new Promise(resolve=>{finishEarlier=resolve}) : Promise.resolve(oldNight)
 services.reports.getFeedback=async id=>({nightId:id})
 const {page,calls}=load(roots[0],'report',services)
 await page.load()
 assert.equal(page.data.recentDays.length,7)
 assert.equal(page.data.selectedDate,'2026-08-31')
 const select=date=>page.selectQuickDate({currentTarget:{dataset:{date}}})
 const earlier=select('2026-08-30')
 await select('2026-08-29')
 finishEarlier({...latest,id:'night-2026-08-30',sourceDate:'2026-08-30'})
 await earlier
 assert.equal(page.data.report.id,oldNight.id)
 assert.equal(page.data.feedback.nightId,oldNight.id)
 await page.openData()
 await page.onShow()
 await page.openFeedback()
 assert.equal(calls[0].url,'/pages/report-detail/index?date=2026-08-29&nightId=device-08-29')
 assert.equal(calls[1].url,'/pages/trends/index?focus=feedback&nightId=device-08-29')
})

test('the capsule chart preserves a recorded zero and leaves unverified responses unfilled', async () => {
 const services=servicesFor(roots[0])
 const latest=await services.reports.getLatest()
 let responseCount=0
 services.reports.getByNightId=async()=>({...latest, interventionCount:5, responseCount, snoreStoppedResponses:null, turnOverResponses:null})
 const {page}=load(roots[0],'report-detail',services)
 await page.onLoad({date:'2026-08-31'})
 assert.equal(page.data.reminderComparison[0].fill,100)
 assert.equal(page.data.reminderComparison[1].value,0)
 assert.equal(page.data.reminderComparison[1].fill,0)
 responseCount=6
 await page.load()
 assert.equal(page.data.reminderComparison[1].value,null)
 assert.equal(page.data.reminderComparison[1].fill,0)
})

test('collection shortcut shows distinct valid nights and follows a confirmed calibration plan', async () => {
 const root=roots[0], services=servicesFor(root)
 services.reports.getCollectionNights = async () => [
   { date:'2026-08-30', valid:true }, { date:'2026-08-30', valid:true },
   { date:'2026-08-31', valid:true }, { date:'2026-09-01', valid:false },
 ]
 let plan = null
 services.device = { getTonightSettings:async () => ({ personalStrategy:plan }) }
 const {page}=load(root,'report-detail',services)
 await page.onShow()
 assert.equal(page.data.collection.nights,2)
 assert.equal(page.data.collection.days,7)
 plan={deviceConfirmed:true,stage:'calibrating'}
 services.reports.getPeriodTrend=async ({periodEnd})=>[{dateISO:periodEnd,valid:true}]
 await page.onShow()
 assert.equal(page.data.collection.calibrating,true)
 assert.equal(page.data.collection.nights,1)
})

test('week and month captions are compact and retain the year for historical ranges', async () => {
 const services=servicesFor(roots[0])
 services.reports.getPeriodTrend=async()=>[]
 const {page}=load(roots[0],'report-detail',services)
 await page.onLoad({date:'2026-08-31'})
 page.setData({maxDate:'2026-11-09'})
 await page.changeDate('2026-08-31','week')
 assert.equal(page.data.selectedDateLabel,'8/31–9/6')
 assert.match(page.data.accessibleDateLabel,/2026年8月31日.*2026年9月6日/)
 await page.changeDate('2026-08-31','month')
 assert.equal(page.data.selectedDateLabel,'8月')
 await page.changeDate('2025-08-31','month')
 assert.equal(page.data.selectedDateLabel,'2025年8月')
 await page.changeDate('2025-12-30','week')
 assert.equal(page.data.selectedDateLabel,'2025/12/29–2026/1/4')
})

test('sleep home shows recorded reminder counts and summarizes a complete night only', async () => {
 const services=servicesFor(roots[0])
 const night=await services.reports.getLatest()
 const moments=['00:55','03:22','04:01','04:26','05:45']
 let events=moments.map((time,index)=>({id:'reminder-'+index,type:'intervention',time,nightId:night.id}))
 services.reports.getEvents=async input=>{
   assert.equal(input.nightId,night.id)
   return events
 }
 const {page}=load(roots[0],'report',services)
 await page.load()
 await new Promise(setImmediate)
 assert.equal(page.data.reminderCount,5)
 assert.equal(page.data.responseCount,4)
 assert.equal(page.data.nightSummary,'提醒多出现在后半夜。')
 services.reports.getLatest=async()=>({...night,interventionCount:0})
 await page.load()
 assert.equal(page.data.nightSummary,'')
 services.reports.getLatest=async()=>night
 events=events.slice(0,2)
 await page.load()
 await new Promise(setImmediate)
 assert.equal(page.data.nightSummary,'')
})

test('sleep home distinguishes a confirmed zero from missing or contradictory response data', async () => {
 const services=servicesFor(roots[0])
 const night=await services.reports.getLatest()
 let record={...night,observationOnly:true,interventionCount:0,snoreStoppedResponses:0,turnOverResponses:0}
 services.reports.getLatest=async()=>record
 const {page}=load(roots[0],'report',services)
 await page.load()
 assert.equal(page.data.reminderCount,0)
 assert.equal(page.data.observationOnly,true)
 assert.equal(page.data.responseCount,null)
 record={...night,interventionCount:2,snoreStoppedResponses:3,turnOverResponses:1}
 await page.load()
 assert.equal(page.data.responseCount,null)
 record={...night,interventionCount:null,snoreStoppedResponses:null,turnOverResponses:null,effectiveMonitoringMinutes:null}
 await page.load()
 assert.equal(page.data.reminderCount,null)
 assert.equal(page.data.durationHours,null)
 assert.equal(page.data.responseCount,null)
 assert.equal(page.data.nightSummary,'')
})

test('morning feedback loads and saves the exact night shown on sleep home', async () => {
 const root=roots[0], services=servicesFor(root)
 const report=load(root,'report',services)
 await report.page.load()
 await report.page.openFeedback()
 const params=Object.fromEntries(new URL(report.calls[0].url,'https://test.invalid').searchParams)
 assert.equal(params.nightId,'night-2026-08-31')
 services.reports.getLatest=async()=>{throw new Error('must use the selected night')}
 let saved
 services.reports.submitFeedback=async input=>{saved=input;return input}
 const trends=load(root,'trends',services)
 trends.page.onLoad(params)
 await trends.page.load()
 assert.equal(trends.page.data.currentNightId,params.nightId)
 trends.page.chooseBoolean({currentTarget:{dataset:{key:'awakened',value:'false'}}})
 trends.page.chooseBoolean({currentTarget:{dataset:{key:'partnerAffected',value:'false'}}})
 trends.page.setEnergy({currentTarget:{dataset:{value:4}}})
 await trends.page.submitFeedback()
 assert.equal(saved.nightId,params.nightId)
 services.reports.getByNightId=async()=>({id:'another-night',hasData:true})
 await trends.page.load()
 assert.equal(trends.page.data.phase,'empty')
 assert.equal(trends.page.data.currentNightId,'')
})
