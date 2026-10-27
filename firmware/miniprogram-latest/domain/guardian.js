const STOPPABLE_STATES = ['intervening', 'verifying']

function canStopIntervention(snapshot) {
  return Boolean(
    snapshot &&
    ['ble', 'device-runtime'].includes(snapshot.source) &&
    snapshot.freshness === 'fresh' &&
    STOPPABLE_STATES.includes(snapshot.guardianState)
  )
}

module.exports = {
  STOPPABLE_STATES,
  canStopIntervention
}
