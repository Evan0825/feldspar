const { test } = require('node:test')
const assert = require('node:assert/strict')
const { parseSafetyReply, parseIoReply } = require('../firmware/miniprogram-latest/domain/safety-state')

const reply = (fields) => ({ type: 'SAFETY', fields: fields.split(',') })
test('safety readback requires matching request and valid driver state', () => {
  const stopped = parseSafetyReply(reply('7,ok,HAPTIC,stopped,0,0,0,1'), 7)
  assert.equal(stopped.stopLatched, true)
  assert.equal(stopped.physicalFeedback, false)
  assert.equal(parseSafetyReply(reply('6,ok,HAPTIC,ok,0,0,0,0'), 7), null)
  assert.equal(parseSafetyReply(reply('7,ok,HAPTIC,ok,1,20,9000,0'), 7).active, true)
  for (const fields of ['7,ok,HAPTIC,ok,1,20,9000,1', '7,ok,HAPTIC,ok,0,20,0,0',
    '7,ok,HAPTIC,ok,0,0,0,2', '7,ok,HAPTIC,ok,1,101,1000,0',
    '7,ok,HAPTIC,ok,1,20,10001,0', '7,ok,HAPTIC,ok,1,20,NaN,0']) {
    assert.equal(parseSafetyReply(reply(fields), 7), null, fields)
  }
  assert.equal(parseSafetyReply(reply('7,error,HAPTIC,storage,0,0,0,1'), 7).accepted, false)
  assert.equal(parseSafetyReply(reply('7,ok,HAPTIC,ok,0,,,1'), 7), null)
})

test('IO readback keeps light, volume and play state distinct', () => {
  const io = fields => ({ type: 'IO', fields: fields.split(',') })
  const result = parseIoReply(io('3,1,40,21,5,60,1,2'), 3)
  assert.deepEqual(result.light, { enabled: true, r: 40, g: 21, b: 5 })
  assert.deepEqual(result.sound, { volume: 60, playing: true, paused: false, index: 2 })
  for (const fields of ['2,1,40,21,5,60,1,2', '3,1,101,21,5,60,1,2', '3,1,40,21,5,60,3,2', '3,1,,21,5,60,1,2']) {
    assert.equal(parseIoReply(io(fields), 3), null)
  }
})
