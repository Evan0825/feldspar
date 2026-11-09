const env = require('../config/env')
const { attachAiUi } = require('./ai-ui')
const { createMockServices } = require('./mock/index')
const { createRealServices } = require('./real/index')

function createServices({ mode = env.serviceMode } = {}) {
  const resolvedMode = env.demoMode ? 'mock' : mode
  return attachAiUi(resolvedMode === 'real' ? createRealServices() : createMockServices())
}

const services = createServices()

module.exports = Object.assign(services, { createServices })
