let recordsView = null
let sleepSourceRequest = null

function resetNavigation(page) { page._routePending = false }

function navigate(page, wxApi, method, options) {
  if (page._routePending) return Promise.resolve(false)
  page._routePending = true
  return new Promise((resolve) => {
    const fail = (error) => {
      resetNavigation(page)
      if (options.fail) options.fail(error)
      if (wxApi.showToast) wxApi.showToast({ title: '暂时无法打开，请重试', icon: 'none' })
      resolve(false)
    }
    try {
      wxApi[method]({
        ...options,
        success(result) { if (options.success) options.success(result); resolve(true) },
        fail,
        complete(result) { if (options.complete) options.complete(result) },
      })
    } catch (error) { fail(error) }
  })
}

function goAiHome(page, wxApi) { return navigate(page, wxApi, 'switchTab', { url: '/pages/ai/index' }) }

function openAiAuthorization(page, wxApi) { return goAiHome(page, wxApi) }

async function openSleepSource(page, wxApi, source = {}) {
  if (page._routePending) return false
  const request = {}
  for (const key of ['kind', 'nightId', 'sourceDate', 'periodStart', 'periodEnd', 'interpretationId', 'revision']) {
    if (source[key] != null) request[key] = source[key]
  }
  sleepSourceRequest = request
  const opened = await navigate(page, wxApi, 'switchTab', { url: '/pages/report/index' })
  if (!opened && sleepSourceRequest === request) sleepSourceRequest = null
  return opened
}
function takeSleepSourceRequest() { const request = sleepSourceRequest; sleepSourceRequest = null; return request }

function rememberRecordsView(ownerId, state) {
  if (!ownerId) return
  recordsView = { ownerId, tab: state.tab === 'interpretations' ? 'interpretations' : 'conversations', scrollTop: Math.max(0, Number(state.scrollTop) || 0) }
}
function getRecordsView(ownerId) {
  return recordsView && recordsView.ownerId === ownerId ? { ...recordsView } : { tab: 'conversations', scrollTop: 0 }
}

module.exports = { navigate, resetNavigation, goAiHome, openAiAuthorization, openSleepSource, takeSleepSourceRequest, rememberRecordsView, getRecordsView }
