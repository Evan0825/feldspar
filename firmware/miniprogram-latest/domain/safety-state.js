const DRIVER_RESULTS = ['ok', 'invalid', 'disabled', 'unsafe', 'expired', 'busy',
  'duplicate', 'cooldown', 'budget', 'storage', 'stopped', 'unavailable']

function parseSafetyReply(message, requestId) {
  if (!message || message.type !== 'SAFETY') return null
  const f = message.fields || []
  if (f.length !== 8 || !/^\d+$/.test(f[0]) || Number(f[0]) !== requestId || !['ok', 'error'].includes(f[1]) ||
      f[2] !== 'HAPTIC' || !DRIVER_RESULTS.includes(f[3])) return null
  if (![f[4], f[7]].every(v => v === '0' || v === '1')) return null
  if (!/^\d+$/.test(f[5]) || !/^\d+$/.test(f[6])) return null
  const percent = Number(f[5])
  const remainingMs = Number(f[6])
  if (!Number.isInteger(percent) || percent < 0 || percent > 100 ||
      !Number.isInteger(remainingMs) || remainingMs < 0 || remainingMs > 10000) return null
  const active = f[4] === '1'
  const stopLatched = f[7] === '1'
  if ((!active && (percent !== 0 || remainingMs !== 0)) || (active && (stopLatched || percent === 0 || remainingMs === 0))) return null
  return { requestId, accepted: f[1] === 'ok', driverResult: f[3], active,
    percent, remainingMs, stopLatched, physicalFeedback: false }
}

function parseIoReply(message, requestId) {
  if (!message || message.type !== 'IO' || !Array.isArray(message.fields) || ![8, 9, 11].includes(message.fields.length)) return null
  const f = message.fields
  if (!f.every(value => /^\d+$/.test(value)) || Number(f[0]) !== requestId || !['0','1'].includes(f[1])) return null
  const n = f.map(Number)
  if (n.slice(2,6).some(value => value > 100) || n[6] > 2 || n[7] > 255 ||
      (n.length >= 9 && (n[8] > 1 || n[8] === 1 && n[1] === 0))) return null
  const light = { enabled: n[1] === 1, r: n[2], g: n[3], b: n[4] }
  if (n.length >= 9) light.mode = n[8] === 1 ? 'bedtime-breathe' : 'night-low'
  const sound = { volume: n[5], playing: n[6] === 1, paused: n[6] === 2, index: n[7] }
  if (n.length === 11) {
    if (![0, 15, 30, 60].includes(n[9]) || n[10] > n[9] * 60) return null
    Object.assign(sound, { timerSupported: true, timer: n[9] || 'all-night', timerRemainingSeconds: n[10] })
  }
  return { requestId, light, sound, physicalFeedback: false }
}

module.exports = { parseSafetyReply, parseIoReply }
