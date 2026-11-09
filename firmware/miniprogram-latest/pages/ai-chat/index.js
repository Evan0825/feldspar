const services = require('../../services/index')
const { toUserError } = require('../../domain/service-error')
const { buildDirectShare, buildTimelineShare } = require('../../domain/share-card')
const { navigate, goAiHome, resetNavigation, openSleepSource } = require('../../domain/ai-navigation')
const { buildConversationContext } = require('../../domain/ai-conversation-context')

const SOFT_TURN_LIMIT = 12
const HARD_TURN_LIMIT = 20
const RECENT_MESSAGE_LIMIT = 12
let idSequence = 0
const activeAnswers = new Map()

Page({
  data: {
    sessionId: '', sessionTitle: '', createdAt: '', dayKey: '', contextDate: '', ownerId: '', contextKind: '',
    interpretationId: '', interpretationRevision: 0,
    contextTitle: '', contextConclusion: '', contextSummary: '',
    contextEvidence: [], contextEvidenceError: '', contextQuality: '', contextSourceLabel: '', contextSource: null, contextEvidenceExpanded: false,
    inputText: '', inputFocused: false, keyboardHeight: 0,
    messages: [], visibleMessages: [], collapsedMessageCount: 0, olderMessagesExpanded: false,
    conversationSummary: '', carriedMemory: '', contextLimitReached: false,
    memoryIncomplete: false, memoryExpanded: false, previousSessionId: '', readOnly: false,
    expandedMessageId: '', scrollTarget: '', isHistorySession: false,
    quickQuestions: ['这份记录值得注意什么？', '今晚应该怎么设置？'],
    loading: true, sending: false, consentRequired: false,
    error: null, sendError: null, saveError: null, draftError: null, actionError: null, saveStatus: '', storageMode: '',
  },

  onLoad(options = {}) {
    this._disposed = false
    this._entryOptions = options
    this._entryPromise = this.initialize(options)
    return this._entryPromise
  },
  async initialize(options) {
    if (options.sessionId) await this.restoreSession(decode(options.sessionId))
    else await this.loadContext(decode(options.interpretationId), options)
    if (this._disposed || this.data.error || this.data.consentRequired || this.data.readOnly) return
    const question = decode(options.question)
    if (question) {
      this.updateView({ inputText: question })
      await this.sendMessage(question)
    } else if (options.focus === '1') this.updateView({ inputFocused: true })
  },
  async onShow() {
    resetNavigation(this)
    if (this._disposed || this.data.loading) return
    const needsRestore = this.data.consentRequired || this.data.readOnly
    const historyId = this._entryOptions && decode(this._entryOptions.sessionId)
    const entry = this._entryOptions || {}
    const archivedInterpretation = Boolean(entry.interpretationId && Number.isInteger(Number(entry.revision)) && Number(entry.revision) > 0)
    const authorized = await this.checkAuthorization(Boolean(historyId || archivedInterpretation))
    if (this._ownerChanged) {
      this._ownerChanged = false
      this._sending = false
      return this.newGeneralConversation()
    }
    if (authorized && this.data.readOnly && historyId) return this.restoreSession(historyId)
    if (authorized && this.data.readOnly && archivedInterpretation) return this.loadContext(decode(entry.interpretationId), entry)
    if (authorized && needsRestore) return this.initialize({ ...this._entryOptions, question: '' })
  },
  onHide() { this.flushDraft() },
  onUnload() { this._disposed = true; this.flushDraft() },
  updateView(next) { if (!this._disposed) this.setData(next) },

  async checkAuthorization(allowReadOnly = false) {
    try {
      const profile = await services.auth.getProfile()
      const ownerId = profile.id || ''
      if (this.data.ownerId && this.data.ownerId !== ownerId) {
        this.clearPrivateContent(!profile.aiDataAuthorized)
        this._ownerChanged = Boolean(profile.aiDataAuthorized)
        this.updateView({ ownerId })
        return false
      }
      this.updateView({ ownerId })
      if (profile.aiDataAuthorized) { this.updateView({ consentRequired: false, readOnly: false, actionError: null }); return true }
      if (allowReadOnly && ownerId) {
        if (!this.data.readOnly) this.clearPrivateContent(false)
        this.updateView({ readOnly: true, consentRequired: false, ownerId })
        return true
      }
      this.clearPrivateContent(true)
      return false
    } catch (error) {
      this._retryAction = () => this.checkAuthorization()
      this.updateView({ [this.data.loading ? 'error' : 'actionError']: toUserError(error, 'AI 授权状态'), loading: false })
      return false
    }
  },
  clearPrivateContent(consentRequired) {
    activeAnswers.delete(`${this.data.ownerId}:${this.data.sessionId}`)
    this._operationVersion = (this._operationVersion || 0) + 1
    this._sending = false
    clearTimeout(this._draftTimer)
    this._pendingSnapshot = null
    this._draftKey = ''
    this.updateView({
      consentRequired, readOnly: false, loading: false, sending: false, inputFocused: false,
      sessionId: '', sessionTitle: '', messages: [], visibleMessages: [], inputText: '',
      contextTitle: '', contextDate: '', contextKind: '', contextConclusion: '', contextSummary: '',
      interpretationId: '', interpretationRevision: 0, conversationSummary: '', carriedMemory: '',
      contextEvidence: [], contextEvidenceError: '', contextQuality: '', contextSourceLabel: '', contextSource: null,
      memoryIncomplete: false, memoryExpanded: false, previousSessionId: '',
      collapsedMessageCount: 0, saveStatus: '', sendError: null, saveError: null, draftError: null, actionError: null, error: null,
    })
  },
  async loadContext(interpretationId, options = {}) {
    if (this._sending) return
    this.updateView({ loading: true, error: null })
    const revision = Number(options.revision) || undefined
    const allowReadOnly = Boolean(interpretationId && Number.isInteger(revision) && revision > 0)
    if (!await this.checkAuthorization(allowReadOnly) || this._disposed) return
    const version = this._operationVersion = (this._operationVersion || 0) + 1
    try {
      const interpretation = interpretationId ? await services.ai.getInterpretation(interpretationId, revision, options.sourceDate) : null
      if (version !== this._operationVersion || this._disposed) return
      if (interpretationId && (!interpretation || interpretation.interpretationId !== interpretationId || (revision && interpretation.revision !== revision))) throw new Error('AI_INTERPRETATION_NOT_FOUND')
      const contextDate = recordDate(interpretation) || absoluteDate(options.sourceDate)
      const dayKey = absoluteDate(options.dayKey) || chinaDay(new Date())
      this.updateView({
        sessionId: '', sessionTitle: '', createdAt: '', dayKey, contextDate, contextKind: interpretation ? interpretation.kind : contextDate ? 'single-night' : '',
        interpretationId: interpretation ? interpretation.interpretationId : '',
        interpretationRevision: interpretation ? interpretation.revision : 0,
        contextTitle: contextLabel(contextDate, interpretation && interpretation.kind),
        contextConclusion: interpretation ? interpretation.conclusion : contextDate ? '想了解这晚的什么？' : '有什么想聊的？',
        contextSummary: interpretation ? interpretation.summary : '',
        ...interpretationView(interpretation),
        ...(!interpretation && contextDate ? { contextSource: { kind: 'single-night', sourceDate: contextDate }, contextSourceLabel: contextDate } : {}),
        messages: [], visibleMessages: [], collapsedMessageCount: 0, olderMessagesExpanded: false,
        conversationSummary: '', carriedMemory: '', contextLimitReached: false, isHistorySession: false,
        memoryIncomplete: false, memoryExpanded: false, previousSessionId: '',
        sendError: null, saveError: null, saveStatus: '', storageMode: '',
        quickQuestions: interpretation ? (interpretation.kind === 'seven-night' ? ['这 7 晚的趋势说明什么？', '哪些记录影响了判断？'] : ['这份记录值得注意什么？', '今晚应该怎么设置？']) : contextDate ? ['这晚有哪些值得留意的事件？', '怎样看提醒后的响应？'] : ['怎样建立睡前习惯？', '共享睡眠怎样减少打扰？'],
      })
      this._draftKey = this.data.readOnly ? '' : `day:${dayKey}:${interpretationId || contextDate || 'general'}:${revision || (interpretation && interpretation.revision) || 0}`
      const inputText = this.data.readOnly ? '' : await services.ai.getChatDraft(this._draftKey)
      if (version === this._operationVersion) this.updateView({ inputText: inputText || '', loading: false })
    } catch (error) {
      if (version === this._operationVersion) this.updateView({ error: toUserError(error, '对话内容'), loading: false })
    }
  },
  async restoreSession(sessionId) {
    if (this._sending) return
    this.updateView({ loading: true, error: null })
    if (!await this.checkAuthorization(true) || this._disposed) return
    const version = this._operationVersion = (this._operationVersion || 0) + 1
    try {
      const active = !this.data.readOnly && activeAnswers.get(`${this.data.ownerId}:${sessionId}`)
      const unsaved = active ? await active : null
      if (version !== this._operationVersion || this._disposed) return
      const stored = await services.ai.getChatSession(sessionId)
      if (!stored) throw new Error('AI_CHAT_SESSION_NOT_FOUND')
      const session = unsaved || stored
      if (session.ownerId && session.ownerId !== this.data.ownerId) throw new Error('AI_CHAT_SESSION_NOT_FOUND')
      if (version !== this._operationVersion || this._disposed) return
      this._pendingSnapshot = unsaved || null
      this._savedSessionId = sessionId
      const messages = (session.messages || []).map((message) => ({ ...message, status: message.status === 'sending' ? 'failed' : message.status }))
      this._draftKey = this.data.readOnly ? '' : `session:${session.sessionId}`
      const inputText = this.data.readOnly ? '' : await services.ai.getChatDraft(this._draftKey)
      if (version !== this._operationVersion || this._disposed) return
      this.updateView({
        sessionId: session.sessionId, sessionTitle: session.title || '', createdAt: session.createdAt || '',
        dayKey: session.dayKey || '', contextDate: session.contextDate || '', contextKind: session.kind || session.contextKind || '',
        interpretationId: session.interpretationId || '', interpretationRevision: session.interpretationRevision || 0,
        contextTitle: session.contextDate ? contextLabel(session.contextDate, session.kind || session.contextKind) : session.contextTitle || '历史对话',
        contextConclusion: session.contextConclusion || '', contextSummary: session.contextSummary || '',
        conversationSummary: session.conversationSummary || '', carriedMemory: session.carriedMemory || '',
        previousSessionId: session.previousSessionId || '',
        ...interpretationView(null),
        storageMode: session.storageMode || '', messages, inputText: inputText || '',
        isHistorySession: true, loading: false, saveError: unsaved ? saveError() : null,
        sendError: !this.data.readOnly && messages.some((message) => message.role === 'user' && message.status === 'failed') ? answerError() : null,
        saveStatus: unsaved ? '' : savedLabel(session.storageMode),
      })
      this.refreshConversationState()
      if (session.interpretationId) {
        try {
          if (!session.interpretationRevision) throw new Error('MISSING_REVISION')
          const interpretation = await services.ai.getInterpretation(session.interpretationId, session.interpretationRevision, session.contextDate)
          if (!interpretation || interpretation.interpretationId !== session.interpretationId || interpretation.revision !== session.interpretationRevision) throw new Error('MISSING_REVISION')
          if (version !== this._operationVersion || this._disposed) return
          this.updateView({ ...interpretationView(interpretation), contextKind: interpretation.kind })
        } catch (_) {
          if (version !== this._operationVersion || this._disposed) return
          this.updateView({ contextEvidenceError: '这段对话的原始依据暂不可用，已保留对话全文。' })
        }
        this.refreshConversationState()
      }
    } catch (error) {
      if (version === this._operationVersion) this.updateView({ loading: false, error: toUserError(error, '聊天记录') })
    }
  },
  retryLoad() { return this.initialize(this._entryOptions || {}) },
  newGeneralConversation() {
    if (this.data.readOnly) return
    return this.changeConversation(() => {
      this._entryOptions = { focus: '1' }
      return this.initialize(this._entryOptions)
    })
  },
  goAiHome() { return this.changeConversation(() => goAiHome(this, wx), true) },
  openAuthorization() { return this.goAiHome() },
  retryAuthorization() { return this.checkAuthorization() },
  retryAction() { return this._retryAction ? this._retryAction() : this.checkAuthorization() },
  onInput(event) {
    if (this.data.readOnly) return
    this.updateView({ inputText: event.detail.value })
    clearTimeout(this._draftTimer)
    this._draftTimer = setTimeout(() => this.flushDraft(), 240)
  },
  onKeyboardHeightChange(event) {
    this.updateView({ keyboardHeight: Math.max(0, Number(event.detail.height) || 0) })
    this.scrollToEnd()
  },
  onInputBlur() { this.updateView({ inputFocused: false }) },
  flushDraft() {
    clearTimeout(this._draftTimer)
    if (!this._draftKey || this.data.consentRequired || this.data.readOnly) return Promise.resolve(true)
    return this.writeDraft(this._draftKey, this.data.inputText)
  },
  writeDraft(key, inputText) {
    const ownerId = this.data.ownerId
    const version = this._operationVersion
    this._draftWrites = (this._draftWrites || Promise.resolve()).catch(() => {}).then(() => version === this._operationVersion && !this.data.readOnly && !this.data.consentRequired ? services.ai.saveChatDraft(key, inputText, { ownerId }) : null)
    return this._draftWrites.then(() => {
      if (version === this._operationVersion) this.updateView({ draftError: null })
      return true
    }).catch(() => {
      if (version === this._operationVersion) this.updateView({ draftError: { title: '草稿暂未保存', detail: '文字仍在输入框中，请重试。' } })
      return false
    })
  },
  openHistory() {
    return this.changeConversation(() => navigate(this, wx, 'redirectTo', { url: '/pages/ai-records/index' }))
  },
  openSession(event) {
    const sessionId = event.currentTarget.dataset.id
    if (!sessionId || sessionId === this.data.sessionId) return
    return this.changeConversation(() => navigate(this, wx, 'redirectTo', { url: `/pages/ai-chat/index?sessionId=${encodeURIComponent(sessionId)}` }))
  },
  async changeConversation(action, allowSending = false) {
    if (this._changingConversation || this._routePending || this._disposed) return false
    if (!allowSending && (this._sending || this.data.sending)) { wx.showToast({ title: '请等本次回答完成', icon: 'none' }); return false }
    this._changingConversation = true
    const version = this._operationVersion
    try {
      if (!await this.saveBeforeSwitch(version)) return false
      return await action()
    } finally {
      this._changingConversation = false
    }
  },
  async saveBeforeSwitch(version) {
    if (this.data.readOnly) return !this._disposed && version === this._operationVersion
    let draftKey, inputText, sessionSave
    do {
      draftKey = this._draftKey
      inputText = this.data.inputText
      if (!await this.flushDraft()) { wx.showToast({ title: '草稿暂未保存，请先重试', icon: 'none' }); this.scrollToEnd(); return false }
      sessionSave = this._sessionSavePromise
      if (sessionSave) await sessionSave
      if (this._disposed || version !== this._operationVersion) return false
      if (this._sending && this.data.sessionId && this._savedSessionId !== this.data.sessionId && !this.data.saveError) {
        await this.persistSession(this.sessionSnapshot(), version)
      }
    } while (draftKey !== this._draftKey || inputText !== this.data.inputText || sessionSave !== this._sessionSavePromise)
    if (this.data.saveError || this.data.draftError) { wx.showToast({ title: '请先重试保存', icon: 'none' }); return false }
    return !this._disposed && version === this._operationVersion
  },
  resetConversation() { return this.startNewConversation() },
  startNewConversation() { return this.beginNewConversation(false) },
  continueInNewConversation() { return this.beginNewConversation(true) },
  beginNewConversation(preserveDraft) {
    if (this.data.consentRequired || this.data.readOnly) return
    return this.changeConversation(() => this.replaceConversation(preserveDraft))
  },
  replaceConversation(preserveDraft) {
    const memory = buildConversationContext(this.data, this.data.messages)
    const carriedMemory = preserveDraft ? memory.summary : ''
    const previousSessionId = preserveDraft ? this.data.sessionId || this.data.previousSessionId : ''
    this._operationVersion = (this._operationVersion || 0) + 1
    this._pendingSnapshot = null
    this._draftKey = `day:${chinaDay(new Date())}:${this.data.interpretationId || 'general'}:${this.data.interpretationRevision || 0}`
    this.updateView({
      sessionId: '', sessionTitle: '', createdAt: '', dayKey: chinaDay(new Date()),
      inputText: preserveDraft ? this.data.inputText : '', inputFocused: true,
      messages: [], visibleMessages: [], collapsedMessageCount: 0, olderMessagesExpanded: false,
      conversationSummary: '', carriedMemory, contextLimitReached: false, scrollTarget: '',
      previousSessionId, memoryIncomplete: preserveDraft && memory.incomplete, memoryExpanded: false,
      isHistorySession: false, error: null, sendError: null, saveError: null, saveStatus: '',
    })
    const version = this._operationVersion
    const initialInput = this.data.inputText
    return services.ai.getChatDraft(this._draftKey).then((saved) => {
      if (version !== this._operationVersion || this._disposed) return
      if (!initialInput && !this.data.inputText && saved) this.updateView({ inputText: saved })
      return this.flushDraft()
    }).catch(() => {
      if (version === this._operationVersion) this.updateView({ draftError: { title: '草稿暂未恢复', detail: '可继续输入，或重试读取草稿。' } })
    })
  },
  useQuickQuestion(event) { return this.sendMessage(event.currentTarget.dataset.question) },
  async sendMessage(input) {
    if (this._sending || this._changingConversation || this._routePending || this.data.loading || this.data.consentRequired || this.data.readOnly) return
    this.refreshConversationState()
    if (this.data.contextLimitReached || this.data.sendError) return
    const text = String(typeof input === 'string' ? input : this.data.inputText || '').trim()
    if (!text) return
    this._sending = true
    if (!await this.checkAuthorization() || this._disposed) { this._sending = false; return }
    const now = new Date().toISOString()
    const userMessage = { messageId: makeId('user'), role: 'user', text, status: 'sending', createdAt: now }
    const sessionId = this.data.sessionId || makeId('chat')
    const version = this._operationVersion
    this.updateView({ sessionId, createdAt: this.data.createdAt || now, messages: [...this.data.messages, userMessage], inputText: '', sending: true, error: null, sendError: null })
    const previousDraftKey = this._draftKey
    this._draftKey = `session:${sessionId}`
    if (previousDraftKey && previousDraftKey !== this._draftKey) this.writeDraft(previousDraftKey, '')
    await this.flushDraft()
    if (version !== this._operationVersion) return
    this.refreshConversationState()
    return this.startAnswer(userMessage)
  },
  async retryAnswer() {
    if (this._sending || this.data.loading || this.data.consentRequired || this.data.readOnly) return
    const userMessage = this.data.messages.find((message) => message.role === 'user' && message.status === 'failed')
    if (!userMessage) return
    this._sending = true
    if (!await this.checkAuthorization() || this._disposed) { this._sending = false; return }
    this.updateView({ messages: this.data.messages.map((message) => message.messageId === userMessage.messageId ? { ...message, status: 'sending' } : message), sending: true, sendError: null })
    this.refreshConversationState()
    return this.startAnswer({ ...userMessage, status: 'sending' })
  },
  startAnswer(userMessage) {
    const key = `${this.data.ownerId}:${this.data.sessionId}`
    const pending = this.requestAnswer(userMessage)
    activeAnswers.set(key, pending)
    return pending.then((unsaved) => { if (!unsaved && activeAnswers.get(key) === pending) activeAnswers.delete(key) })
  },
  async requestAnswer(userMessage) {
    const version = this._operationVersion
    const snapshot = this.sessionSnapshot()
    await this.persistSession(snapshot, version)
    try {
      if (version !== this._operationVersion) return
      const memory = await services.ai.getMemory()
      if (version !== this._operationVersion) return
      const summary = [snapshot.conversationSummary || snapshot.carriedMemory, memory.summary ? '用户允许参考的偏好：' + memory.summary : ''].filter(Boolean).join('\n')
      const answer = await services.ai.ask({
        requestId: userMessage.messageId,
        interpretationId: snapshot.interpretationId, interpretationRevision: snapshot.interpretationRevision,
        message: userMessage.text, sourceDate: snapshot.contextDate, conversationSummary: summary,
        recentMessages: snapshot.messages.filter((message) => ['user', 'assistant'].includes(message.role) && message.status !== 'discarded').slice(-RECENT_MESSAGE_LIMIT),
      })
      if (version !== this._operationVersion) return
      if (!await this.checkAuthorization() || version !== this._operationVersion) {
        if (version === this._operationVersion) throw new Error('AUTH_CHECK_FAILED')
        const historyId = this._entryOptions && decode(this._entryOptions.sessionId)
        if (!this._disposed && this.data.consentRequired && this.data.ownerId === snapshot.ownerId && historyId) await this.restoreSession(historyId)
        return
      }
      const messages = snapshot.messages.map((message) => message.messageId === userMessage.messageId ? { ...message, status: 'complete' } : message)
      messages.push({ ...answer, messageId: `${userMessage.messageId}-reply`, replyToMessageId: userMessage.messageId, role: 'assistant', status: 'complete', createdAt: answer.createdAt || new Date().toISOString() })
      const completed = { ...snapshot, messages, conversationSummary: buildConversationContext(snapshot, messages).summary }
      this.updateView({ messages, conversationSummary: completed.conversationSummary })
      this.refreshConversationState()
      await this.persistSession(completed, version)
    } catch (error) {
      if (version !== this._operationVersion) return
      const messages = snapshot.messages.map((message) => message.messageId === userMessage.messageId ? { ...message, status: 'failed' } : message)
      this.updateView({ messages, sendError: answerError(error) })
      this.refreshConversationState()
      await this.persistSession({ ...snapshot, messages }, version)
    } finally {
      if (version === this._operationVersion) {
        this._sending = false
        this.updateView({ sending: false })
      }
    }
    return version === this._operationVersion ? this._pendingSnapshot : null
  },
  sessionSnapshot() {
    const data = this.data
    return {
      sessionId: data.sessionId, createdAt: data.createdAt, dayKey: data.dayKey, contextDate: data.contextDate, ownerId: data.ownerId, contextKind: data.contextKind,
      interpretationId: data.interpretationId, interpretationRevision: data.interpretationRevision,
      contextTitle: data.contextTitle, contextConclusion: data.contextConclusion, contextSummary: data.contextSummary,
      conversationSummary: data.conversationSummary, carriedMemory: data.carriedMemory, previousSessionId: data.previousSessionId,
      title: firstUserMessage(data.messages), messages: data.messages,
    }
  },
  persistSession(snapshot, version) {
    if (this.data.readOnly || this.data.consentRequired || version !== this._operationVersion) return Promise.resolve(false)
    this._pendingSnapshot = snapshot
    this.updateView({ saveStatus: '正在保存…' })
    const previous = this._sessionSavePromise || Promise.resolve()
    this._sessionSavePromise = previous.then(() => version === this._operationVersion ? services.ai.saveChatSession(snapshot) : null).then((saved) => {
      if (version !== this._operationVersion || !saved) return false
      this._savedSessionId = snapshot.sessionId
      if (this._pendingSnapshot === snapshot) {
        this._pendingSnapshot = null
        this.updateView({ saveError: null, storageMode: saved.storageMode || '', saveStatus: savedLabel(saved.storageMode) })
      }
      return true
    }).catch(() => {
      if (version === this._operationVersion && this._pendingSnapshot === snapshot) {
        this.updateView({ saveStatus: '', saveError: saveError() })
        if (this._disposed) wx.showToast({ title: '回复暂未保存，请回到记录重试', icon: 'none' })
      }
      return false
    })
    return this._sessionSavePromise
  },
  async retrySave() {
    if (this.data.readOnly) return
    if (!await this.checkAuthorization()) return
    if (this._pendingSnapshot) await this.persistSession(this._pendingSnapshot, this._operationVersion)
    if (!this._sending && !this._pendingSnapshot) activeAnswers.delete(`${this.data.ownerId}:${this.data.sessionId}`)
    await this.flushDraft()
  },
  openPlan() {
    if (this.data.interpretationId && this.data.contextKind === 'single-night' && !this.data.consentRequired && !this.data.readOnly && this.data.visibleMessages.some((message) => message.hasPlan)) return this.changeConversation(() => navigate(this, wx, 'navigateTo', { url: `/pages/ai-plan/index?interpretationId=${encodeURIComponent(this.data.interpretationId)}&revision=${this.data.interpretationRevision}` }), true)
  },
  useLatestContext() { return this.changeConversation(() => this.loadLatestContext()) },
  async loadLatestContext() {
    if (this.data.readOnly) return
    if (!await this.checkAuthorization()) return
    const version = this._operationVersion
    try {
      const home = await services.ai.getDailyHome()
      if (this._disposed || version !== this._operationVersion) return
      if (!home.overview) { wx.showToast({ title: '暂时没有新的睡眠记录', icon: 'none' }); return }
      const overview = home.overview
      if (!await this.saveBeforeSwitch(version)) return
      this._retryAction = null
      this.updateView({ actionError: null })
      this._entryOptions = { interpretationId: overview.interpretationId, revision: overview.revision, dayKey: home.dayKey, sourceDate: home.sourceDate || '', focus: '1' }
      await this.initialize(this._entryOptions)
    } catch (error) {
      if (this._disposed || version !== this._operationVersion) return
      this._retryAction = () => this.useLatestContext()
      this.updateView({ actionError: toUserError(error, '最新记录') })
    }
  },
  toggleEvidence(event) { const id = event.currentTarget.dataset.id; this.updateView({ expandedMessageId: this.data.expandedMessageId === id ? '' : id }) },
  toggleContextEvidence() { this.updateView({ contextEvidenceExpanded: !this.data.contextEvidenceExpanded }) },
  toggleMemory() { this.updateView({ memoryExpanded: !this.data.memoryExpanded }) },
  openSourceRecord() { if (this.data.contextSource) return this.changeConversation(() => openSleepSource(this, wx, this.data.contextSource)) },
  openPreviousConversation() { if (this.data.previousSessionId) return this.openSession({ currentTarget: { dataset: { id: this.data.previousSessionId } } }) },
  editFailedQuestion() { return this.resolveFailedQuestion(true) },
  discardFailedQuestion() { return this.resolveFailedQuestion(false) },
  async resolveFailedQuestion(edit) {
    if (this._sending || this.data.readOnly || this.data.consentRequired) return
    const failed = this.data.messages.find((message) => message.role === 'user' && message.status === 'failed')
    if (!failed || !await this.checkAuthorization()) return
    const editedText = [failed.text, this.data.inputText].filter(Boolean).join('\n\n')
    if (edit && editedText.length > 2000) {
      wx.showToast({ title: '请先处理输入框草稿，原问题仍保留', icon: 'none' })
      return
    }
    this.updateView({
      messages: this.data.messages.map((message) => message === failed ? { ...message, status: 'discarded' } : message),
      inputText: edit ? editedText : this.data.inputText,
      inputFocused: edit, sendError: null,
    })
    this.refreshConversationState()
    await this.persistSession(this.sessionSnapshot(), this._operationVersion)
    await this.flushDraft()
  },
  copyAnswer(event) {
    const answer = this.data.messages.find((message) => message.messageId === event.currentTarget.dataset.id && message.role === 'assistant')
    if (!answer || this.data.consentRequired) return
    wx.setClipboardData({ data: answer.text, success() { wx.showToast({ title: '回答已复制', icon: 'success' }) }, fail() { wx.showToast({ title: '复制失败，请重试', icon: 'none' }) } })
  },
  onShareAppMessage() { return buildDirectShare() },
  onShareTimeline() { return buildTimelineShare() },
  refreshConversationState() {
    if (this._disposed) return
    const messages = this.data.messages || []
    const userTurns = messages.filter((message) => message.role === 'user' && message.status !== 'discarded').length
    const shouldCollapse = userTurns > SOFT_TURN_LIMIT
    const collapsedMessageCount = shouldCollapse ? Math.max(0, messages.length - RECENT_MESSAGE_LIMIT) : 0
    const visible = shouldCollapse && !this.data.olderMessagesExpanded ? messages.slice(-RECENT_MESSAGE_LIMIT) : messages
    let previousDate = ''
    const visibleMessages = visible.map((message) => {
      const date = message.createdAt ? chinaDay(new Date(message.createdAt)) : this.data.dayKey
      const dateLabel = date && date !== previousDate ? messageDateLabel(message.createdAt, date) : ''
      previousDate = date
      const refs = message.evidenceRefs || []
      const evidence = this.data.contextEvidence.filter((item) => refs.includes(item.id))
      return { ...message, dateLabel, evidence, evidenceUnavailable: refs.length > evidence.length,
        sourceLabel: message.source === 'rule-demo' || this.data.contextSourceLabel === '规则演示' || services.serviceMode === 'mock' ? '规则演示' : '',
        hasPlan: Boolean(!this.data.readOnly && this.data.interpretationId && this.data.contextKind === 'single-night' && (message.actions || []).includes('tonight-plan')) }
    })
    const memory = buildConversationContext(this.data, messages)
    this.updateView({
      visibleMessages, collapsedMessageCount,
      conversationSummary: memory.summary, memoryIncomplete: memory.incomplete,
      contextLimitReached: userTurns >= HARD_TURN_LIMIT,
      scrollTarget: visibleMessages.length ? visibleMessages[visibleMessages.length - 1].messageId : '',
    })
  },
  scrollToEnd() { this.updateView({ scrollTarget: 'chat-end' }) },
  toggleOlderMessages() { this.updateView({ olderMessagesExpanded: !this.data.olderMessagesExpanded }); this.refreshConversationState() },
})

function makeId(prefix) { idSequence += 1; return `${prefix}-${Date.now()}-${idSequence}` }
function decode(value) { try { return decodeURIComponent(String(value || '')) } catch (_) { return String(value || '') } }
function absoluteDate(value) { return /^\d{4}-\d{2}-\d{2}$/.test(value || '') ? value : '' }
function recordDate(record) {
  if (!record) return ''
  const nightDate = String(record.nightId || '').match(/\d{4}-\d{2}-\d{2}/)
  return absoluteDate(record.sourceDate) || absoluteDate(record.periodEnd) || (nightDate ? nightDate[0] : '')
}
function chinaDay(date) { return Number.isNaN(date.getTime()) ? '' : new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 10) }
function contextLabel(date, kind) {
  if (!date) return kind ? '所选睡眠记录' : '一般睡眠问题'
  return `${date} · ${kind === 'seven-night' ? '7 晚趋势' : '单晚记录'}`
}
function messageDateLabel(timestamp, day) {
  const now = new Date()
  const label = day === chinaDay(now) ? '今天' : day === chinaDay(new Date(now.getTime() - 86400000)) ? '昨天' : day.replace(/-/g, '/')
  const date = new Date(timestamp)
  const clock = Number.isNaN(date.getTime()) ? '' : new Date(date.getTime() + 8 * 3600000).toISOString().slice(11, 16)
  return `${label}${clock ? ` ${clock}` : ''}`
}
function savedLabel(storageMode) { return storageMode === 'local-demo' || services.serviceMode === 'mock' ? '对话已保存在本机 · 演示' : '对话已保存在本机' }
function saveError() { return { title: '对话暂未保存', detail: '内容仍保留在此页，可以单独重试保存。' } }
function answerError(error) { if (error?.code === 'AI_HISTORICAL_CONTEXT_UNAVAILABLE') return { title: '暂无法续聊这晚记录', detail: error.message }; return { title: '回答暂时中断', detail: error && error.message === 'NOT_CONFIGURED' ? '真实 AI 服务尚未配置。' : '你的问题已保留，可以重新获取回答。' } }
function firstUserMessage(messages) { const first = messages.find((message) => message.role === 'user'); return first ? first.text.slice(0, 28) : '新对话' }
function interpretationView(record) {
  if (!record) return { contextEvidence: [], contextEvidenceError: '', contextQuality: '', contextSourceLabel: '', contextSource: null, contextEvidenceExpanded: false }
  const date = recordDate(record)
  const range = record.kind === 'seven-night' && absoluteDate(record.periodStart) ? `${record.periodStart} — ${record.periodEnd || date}` : date
  return {
    contextTitle: `${range || '日期未记录'} · ${record.kind === 'seven-night' ? '7 晚趋势' : '单晚记录'}`,
    contextQuality: record.dataQuality || '数据质量未提供',
    contextSourceLabel: record.source === 'rule-demo' || services.serviceMode === 'mock' ? '规则演示' : record.sourceLabel || '已存解读',
    contextEvidence: (record.evidence || []).map((item) => ({ ...item, window: item.window === '昨夜' ? date : item.window === '7 晚' ? range : item.window || range })),
    contextEvidenceError: '', contextEvidenceExpanded: false,
    contextSource: { nightId: record.nightId || '', sourceDate: date, kind: record.kind, periodStart: record.periodStart || '', periodEnd: record.periodEnd || '', interpretationId: record.interpretationId, revision: record.revision },
  }
}
