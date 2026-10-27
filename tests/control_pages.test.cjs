const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const root = path.resolve(__dirname, '../firmware/miniprogram-latest')
function page(name, device) {
  let definition
  const toasts = []
  vm.runInNewContext(fs.readFileSync(path.join(root, `pages/${name}/index.js`), 'utf8'), {
    Page: value => { definition = value },
    require: key => key === '../../services/index' ? { device }
      : require(path.resolve(root, 'pages', name, key)),
    wx: { showToast: value => toasts.push(value) },
    setTimeout, clearTimeout,
  })
  definition.data = { ...definition.data }
  definition.setData = value => Object.assign(definition.data, value)
  return { instance: definition, toasts }
}

test('stop page waits for confirmed service result and never toasts success on failure', async () => {
  let resolve
  const pending = new Promise(done => { resolve = done })
  const { instance, toasts } = page('device', { stopAllOutputs: () => pending, getStatus: async () => ({}) })
  const task = instance.safetyAction({ currentTarget: { dataset: { kind: 'stop' } } })
  assert.equal(toasts.length, 0)
  assert.equal(instance.data.safetyBusy, true)
  resolve({ confirmed: true, stopLatched: true })
  await task
  assert.equal(toasts[0].title, '驱动停止已确认')
  const failed = page('device', { stopAllOutputs: async () => { throw new Error('offline') } })
  await failed.instance.safetyAction({ currentTarget: { dataset: { kind: 'stop' } } })
  assert.equal(failed.toasts.length, 0)
  assert.match(failed.instance.data.safetyError, /未确认/)
})

test('sound page keeps last known output until readback and retains sync-pending result', async () => {
  let resolve
  const { instance } = page('sound', { updateSound: () => new Promise(done => { resolve = done }) })
  const previous = { playing: false, volume: 0, scene: 'sleep' }
  Object.assign(instance.data, { sound: previous, controlAvailable: true })
  instance.preparePreviewSource = () => {}
  const task = instance.send({ playing: true })
  assert.equal(instance.data.sound.playing, false)
  resolve({ playing: true, volume: 20, confirmed: true, syncPending: true })
  await task
  assert.equal(instance.data.sound.playing, true)
  assert.equal(instance.data.sound.syncPending, true)
})
