const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.resolve(__dirname, '../firmware/miniprogram-latest')

test('reminder preferences exclude only sound and light; vibration is never editable', () => {
  const { normalizePreferences, reminderRestriction } = require(path.join(root, 'domain/user-preferences'))
  const value = normalizePreferences({ nickname: ' 小月 ', sleepMode: 'solo', excludeSoundReminder: false, excludeLightReminder: true, vibration: false })
  assert.equal(value.nickname, '小月')
  assert.equal(value.sleepMode, 'solo')
  assert.equal(value.excludeSoundReminder, false)
  assert.equal(value.excludeLightReminder, true)
  assert.equal('vibration' in value, false)
  assert.equal(reminderRestriction(value), '不使用灯光提醒')
  assert.equal(reminderRestriction(normalizePreferences()), '不使用声音、灯光')
})

test('seven days never auto-activate or advance a personal strategy', () => {
  const { buildPersonalStrategy } = require(path.join(root, 'domain/personal-strategy'))
  const nights = Array.from({ length: 7 }, (_, index) => ({ date: `10/${index + 1}`, valid: true }))
  const result = buildPersonalStrategy({ nights, profile: {}, status: { host: { online: true }, localLoop: { active: false } } })
  assert.equal(result.stageIndex, 0)
  assert.equal(result.progressLabel, '第7/7天')
  assert.equal(result.badge, '待生成')
  assert.equal(result.operation, '仅观察')
  assert.equal(result.stages.filter((stage) => stage.current).length, 1)
  assert.equal(buildPersonalStrategy({ nights: null }).progressLabel, '进度待同步')
})

test('progress counts distinct valid dates and never invents offline operation', () => {
  const { buildPersonalStrategy } = require(path.join(root, 'domain/personal-strategy'))
  const result = buildPersonalStrategy({ nights: [{ date: '10/1', valid: true }, { date: '10/1', valid: true }, { date: '10/2', valid: false }], status: { host: { online: false } } })
  assert.equal(result.progressLabel, '第1/7天')
  assert.equal(result.operation, '状态待同步')
})

test('stale runtime cannot imply observation and unconfirmed plans cannot advance the stage', () => {
  const { buildPersonalStrategy } = require(path.join(root, 'domain/personal-strategy'))
  const result = buildPersonalStrategy({ nights: [], status: { host: { online: true }, runtimeFreshness: 'missing', localLoop: { active: false } }, plan: { stage: 'preliminary', deviceConfirmed: false } })
  assert.equal(result.operation, '状态待同步')
  assert.equal(result.stageIndex, 0)
  const confirmed = buildPersonalStrategy({ plan: { stage: 'calibrating', deviceConfirmed: true } })
  assert.equal(confirmed.stageIndex, 2)
  assert.equal(confirmed.stages[1].complete, true)
  assert.equal(confirmed.stages[3].current, false)
})

test('preferences edit skips onboarding, round-trips fields and never changes device settings', async () => {
  let saved
  const original = { nickname: '小月', sleepMode: 'shared', excludeSoundReminder: true, excludeLightReminder: false }
  const { page, navigation } = loadPage('onboarding', { auth: { getProfile: async () => original, saveProfile: async (value) => { saved = value; return { ...original, ...value } } } })
  await page.onLoad({ edit: '1' })
  assert.equal(page.data.editingProfile, true)
  assert.equal(page.data.nickname, '小月')
  assert.equal(page.data.excludeLightReminder, false)
  assert.equal(navigation.length, 0)
  page.setNickname({ detail: { value: '新称呼' } })
  page.toggleReminderExclusion({ currentTarget: { dataset: { key: 'excludeSoundReminder' } } })
  await page.saveProfile()
  assert.equal(saved.nickname, '新称呼')
  assert.equal(saved.excludeSoundReminder, false)
  assert.deepEqual(navigation, ['back'])
  assert.equal(page.data.phase, 'profile')
})

test('preference load/save failure cannot navigate away or overwrite a profile with defaults', async () => {
  let saves = 0
  const failed = loadPage('onboarding', { auth: { getProfile: async () => { throw new Error('offline') }, saveProfile: async () => { saves += 1 } } })
  await failed.page.onLoad({ edit: '1' })
  await failed.page.saveProfile()
  assert.equal(saves, 0)
  assert.equal(failed.navigation.length, 0)
  const saveFailure = loadPage('onboarding', { auth: { getProfile: async () => ({ nickname: '原称呼', sleepMode: 'solo' }), saveProfile: async () => { throw new Error('offline') } } })
  await saveFailure.page.onLoad({ edit: '1' })
  saveFailure.page.setNickname({ detail: { value: '保留草稿' } })
  await saveFailure.page.saveProfile()
  assert.equal(saveFailure.page.data.nickname, '保留草稿')
  assert.equal(saveFailure.navigation.length, 0)
  assert.ok(saveFailure.page.data.error)
})

function loadPage(name, services) {
  let definition
  const navigation = []
  vm.runInNewContext(fs.readFileSync(path.join(root, `pages/${name}/index.js`), 'utf8'), {
    Page(value) { definition = value },
    require(request) { return request === '../../services/index' ? services : require(path.resolve(root, 'pages', name, request)) },
    wx: { getStorageSync: () => true, setStorageSync() {}, setNavigationBarTitle() {}, showToast() {}, navigateBack() { navigation.push('back') }, switchTab() { navigation.push('home') }, navigateTo() { navigation.push('setup') } },
    setTimeout, clearTimeout,
  })
  const page = { ...definition, data: JSON.parse(JSON.stringify(definition.data)), setData(value) { Object.assign(this.data, value) } }
  return { page, navigation }
}
