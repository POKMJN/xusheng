const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { BrowserWindow: class {}, session: {} }
  return originalLoad.call(this, request, parent, isMain)
}
const { AUTOMATION_POLL_MS, DouyinService, extractConversationPreview, extractStreakCount, isVideoPreview, mediaPreviewKind, mergeMessageHistory } = require('../electron/douyin-service.cjs')
Module._load = originalLoad

test('contact preview excludes streak counts and other row metadata', () => {
  const lines = ['小明', '726', '10分钟前', '今晚一起吃饭吗']

  assert.equal(extractStreakCount('726', lines), 726)
  assert.equal(extractConversationPreview(lines, '今晚一起吃饭吗', '726'), '今晚一起吃饭吗')
  assert.equal(extractConversationPreview(lines, '', '726'), '今晚一起吃饭吗')
})

test('an actual numeric message is preserved when read from the preview node', () => {
  const lines = ['小明', '726', '刚刚', '311']

  assert.equal(extractConversationPreview(lines, '311', '726'), '311')
})

test('video previews are recognized without treating normal text as video', () => {
  assert.equal(isVideoPreview('[视频]'), true)
  assert.equal(isVideoPreview('对方发来一个视频'), true)
  assert.equal(isVideoPreview('晚上一起吃饭吗'), false)
})

test('Douyin media previews are classified for vision handling', () => {
  assert.equal(mediaPreviewKind('[视频]'), 'video')
  assert.equal(mediaPreviewKind('▶Ι〣〣〣36"'), 'video')
  assert.equal(mediaPreviewKind('分享 @搞个礼物 的评论'), 'share')
  assert.equal(mediaPreviewKind('分享[图集]'), 'album')
  assert.equal(mediaPreviewKind('[图片]'), 'image')
  assert.equal(mediaPreviewKind('[表情]'), 'sticker')
  assert.equal(mediaPreviewKind('晚上一起吃饭吗'), '')
})

test('AI automation passes captured video frames to the draft request', async () => {
  const state = { automation: { autoReply: true, aiDisabledContacts: [], blacklist: [], rules: [], sparks: [], dailyLimit: 30 }, sendHistory: [] }
  const drafted = []
  const service = new DouyinService({
    storage: { get: () => structuredClone(state), addLog: () => {} },
    emit: () => {},
    ai: { hasProvider: () => true, draft: async (payload) => { drafted.push(payload); return { ok: true, text: '这个也太逗了' } } },
  })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: '小明', preview: '[视频]' }] })
  service.captureLatestIncomingMedia = async () => ['data:image/jpeg;base64,frame']
  service.sendMessage = async () => ({ ok: true })
  service.lastSeen.set('小明', '旧消息')

  await service.runAutomation()

  assert.deepEqual(drafted[0].videoFrames, ['data:image/jpeg;base64,frame'])
})

test('composite media capture script compiles independently of page content', async () => {
  const service = new DouyinService({ storage: { get: () => ({}) }, emit: () => {} })
  service.selectConversation = async () => ({ webContents: { executeJavaScript: async (script) => { new Function(script); return null } } })
  service.waitForEditor = async () => ({})
  assert.deepEqual(await service.captureLatestIncomingMedia('小明'), [])
})

test('visible chat history merges without duplicating the overlap', () => {
  const previous = [
    { role: 'contact', text: '第一条' },
    { role: 'me', text: '第二条' },
    { role: 'contact', text: '第三条' },
  ]
  const visible = [
    { role: 'me', text: '第二条' },
    { role: 'contact', text: '第三条' },
    { role: 'me', text: '第四条' },
  ]

  assert.deepEqual(mergeMessageHistory(previous, visible), [
    ...previous,
    { role: 'me', text: '第四条' },
  ])
})

test('learning script compiles and persists the learned contact', async () => {
  const state = { contacts: [{ id: '小明', name: '小明' }], logs: [] }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: (entry) => state.logs.push(entry),
  }
  const win = {
    webContents: {
      executeJavaScript: async (script) => {
        new Function(script)
        return [{ role: 'contact', text: '在吗' }, { role: 'me', text: '在啊' }]
      },
    },
  }
  const service = new DouyinService({
    storage,
    emit: () => {},
    ai: { analyzeConversation: (messages) => ({ messages, contactStyle: { summary: '偏短句' } }) },
  })
  service.selectConversation = async () => win
  service.waitForEditor = async () => ({})

  const result = await service.learnConversation('小明')

  assert.equal(result.learnedMessages, 2)
  assert.equal(state.contacts[0].learning.contactStyle.summary, '偏短句')
  assert.equal(state.logs[0].type, 'language_learned')
})

test('new incoming and sent messages continuously update local learning', () => {
  const state = { contacts: [{ id: '小明', name: '小明', learning: { messages: [{ role: 'contact', text: '旧消息' }] } }] }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
  }
  const service = new DouyinService({
    storage,
    emit: () => {},
    ai: { analyzeConversation: (messages) => ({ messages, updatedAt: '2026-07-19T00:00:00.000Z' }) },
  })

  service.recordConversationMessage('小明', 'contact', '新消息')
  service.recordConversationMessage('小明', 'me', '我的回复')

  assert.deepEqual(state.contacts[0].learning.messages, [
    { role: 'contact', text: '旧消息' },
    { role: 'contact', text: '新消息' },
    { role: 'me', text: '我的回复' },
  ])
})

test('sendMessage falls back to native text insertion', async () => {
  const calls = []
  const results = [{ ok: false }, true, true]
  const win = {
    webContents: {
      executeJavaScript: async () => results.shift(),
      insertText: async (text) => { calls.push(text) },
    },
  }
  const logs = []
  const service = new DouyinService({
    storage: {
      state: { automation: { dailyLimit: 30, cooldown: 0 }, sendHistory: [] },
      get() { return structuredClone(this.state) },
      update(patch) { this.state = { ...this.state, ...patch } },
      addLog: (entry) => logs.push(entry),
    },
    emit: () => {},
  })
  service.selectConversation = async () => win
  service.waitForEditor = async () => ({})
  service.sendCurrentInput = async () => {}

  const result = await service.sendMessage('小明', 'AI 自动回复')

  assert.deepEqual(result, { ok: true })
  assert.deepEqual(calls, ['AI 自动回复'])
  assert.equal(logs[0].type, 'message_sent')
  assert.equal(service.lastSent.get('小明'), 'AI 自动回复')
})

test('combo spark tasks send text first and then the selected emoji', async () => {
  const calls = []
  const service = new DouyinService({ storage: { get: () => ({}) }, emit: () => {} })
  service.sendMessage = async (name, text, metadata) => { calls.push(['text', name, text, metadata.source]); return { ok: true } }
  service.sendEmoji = async (name, emojiName) => { calls.push(['emoji', name, emojiName]); return { ok: true, kind: 'emoji', emojiName } }

  const result = await service.sendTask('小明', { kind: 'combo', message: '今天也来续个火花呀', emojiName: '续火花' })

  assert.deepEqual(calls, [
    ['text', '小明', '今天也来续个火花呀', 'spark_combo_text'],
    ['emoji', '小明', '续火花'],
  ])
  assert.deepEqual(result, { ok: true, kind: 'combo', emojiName: '续火花', message: '今天也来续个火花呀' })
})

test('daily limit blocks every send path without time-based cooldown', () => {
  const now = Date.now()
  const storage = {
    state: {
      automation: { dailyLimit: 2 },
      sendHistory: [
        { at: new Date(now - 60_000).toISOString(), name: '小明' },
      ],
    },
    get() { return structuredClone(this.state) },
    update(patch) { this.state = { ...this.state, ...patch } },
    addLog() {},
  }
  const service = new DouyinService({ storage, emit: () => {} })

  assert.equal(service.getSendAllowance('小明', now).ok, true)
  assert.equal(service.getSendAllowance('小红', now).ok, true)
  storage.state.sendHistory.push({ at: new Date(now - 120_000).toISOString(), name: '小红' })
  assert.match(service.getSendAllowance('小刚', now).reason, /每日上限/)
})

test('auto reply sends once per new incoming message', async () => {
  const state = {
    automation: { autoReply: true, aiDisabledContacts: [], blacklist: [], rules: [{ keywords: ['消息'], replyText: '收到。' }], sparks: [], dailyLimit: 30, replyDelayMin: 0, replyDelayMax: 0 },
    sendHistory: [],
  }
  let preview = '新消息 1'
  const sent = []
  const service = new DouyinService({
    storage: { get: () => structuredClone(state), addLog: () => {} },
    emit: () => {},
    ai: { hasProvider: () => false },
  })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: '小明', preview }] })
  service.sendMessage = async (name, text) => { sent.push({ name, text }); return { ok: true } }
  service.lastSeen.set('小明', '旧消息')

  await service.runAutomation()
  await service.runAutomation()
  preview = '新消息 2'
  await service.runAutomation()

  assert.deepEqual(sent, [
    { name: '小明', text: '收到。' },
    { name: '小明', text: '收到。' },
  ])
})

test('keyword rule replies before AI', async () => {
  const state = {
    automation: { autoReply: true, aiDisabledContacts: [], blacklist: [], rules: [{ keywords: ['在吗'], replyText: '在的。' }], sparks: [], dailyLimit: 30, cooldown: 0, replyDelayMin: 0, replyDelayMax: 0 },
    sendHistory: [],
  }
  let aiCalls = 0
  const sent = []
  const storage = { get: () => structuredClone(state), addLog: () => {} }
  const service = new DouyinService({
    storage,
    emit: () => {},
    ai: { hasProvider: () => true, draft: async () => { aiCalls += 1; return { ok: true, text: 'AI 回复' } } },
  })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: '小明', preview: '你在吗' }] })
  service.sendMessage = async (name, text) => { sent.push({ name, text }); return { ok: true } }
  service.lastSeen.set('小明', '旧消息')

  await service.runAutomation()

  assert.equal(aiCalls, 0)
  assert.deepEqual(sent, [{ name: '小明', text: '在的。' }])
})

test('automation replies immediately without a second contact sync', async () => {
  const state = {
    automation: { autoReply: true, aiDisabledContacts: [], blacklist: [], rules: [{ keywords: ['在吗'], replyText: '在的。' }], sparks: [], dailyLimit: 30, cooldown: 0, replyDelayMin: 0, replyDelayMax: 0 },
    sendHistory: [],
  }
  let syncCount = 0
  let sends = 0
  const logs = []
  const service = new DouyinService({
    storage: { get: () => structuredClone(state), addLog: (entry) => logs.push(entry) },
    emit: () => {},
    ai: { hasProvider: () => false },
  })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => { syncCount += 1; return { contacts: [{ name: '小明', preview: '你在吗' }] } }
  service.sendMessage = async () => { sends += 1 }
  service.lastSeen.set('小明', '旧消息')

  await service.runAutomation()

  assert.equal(sends, 1)
  assert.equal(syncCount, 1)
  assert.equal(service.lastSeen.get('小明'), '你在吗')
  assert.equal(logs.length, 0)
})

test('automation checks for new messages every second', () => {
  assert.equal(AUTOMATION_POLL_MS, 1000)
})

test('AI reply uses saved contact context without blocking on live learning', async () => {
  const state = {
    automation: { autoReply: true, aiDisabledContacts: [], blacklist: [], rules: [], sparks: [], dailyLimit: 30 },
    sendHistory: [],
  }
  let learningCalls = 0
  const drafted = []
  const sent = []
  const contact = { name: '小明', preview: '新消息', learning: { ownerStyle: { summary: '短句' } } }
  const service = new DouyinService({
    storage: { get: () => structuredClone(state), addLog: () => {} },
    emit: () => {},
    ai: { hasProvider: () => true, draft: async (payload) => { drafted.push(payload); return { ok: true, text: '马上回' } } },
  })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [contact] })
  service.learnConversation = async () => { learningCalls += 1 }
  service.sendMessage = async (name, text) => { sent.push({ name, text }) }
  service.lastSeen.set('小明', '旧消息')

  await service.runAutomation()

  assert.equal(learningCalls, 0)
  assert.equal(drafted[0].contact.learning.ownerStyle.summary, '短句')
  assert.deepEqual(sent, [{ name: '小明', text: '【AI · 当前模型】马上回' }])
})

test('spark completion persists across service restarts', async () => {
  const now = new Date()
  const time = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  const state = {
    automation: { autoReply: false, blacklist: [], sparks: [{ id: 7, name: '小明', time, kind: 'text', message: '续火花', enabled: true }], dailyLimit: 30, cooldown: 0 },
    sendHistory: [],
    logs: [],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: (entry) => { state.logs.unshift(entry) },
  }
  let sends = 0
  const createService = () => {
    const service = new DouyinService({ storage, emit: () => {} })
    service.window = { isDestroyed: () => false }
    service.getStatus = async () => ({ connected: true })
    service.syncContacts = async () => ({ contacts: [] })
    service.isLastMessageFromMe = async () => false
    service.sendTask = async () => { sends += 1; return { ok: true } }
    return service
  }

  await createService().runAutomation()
  await createService().runAutomation()

  assert.equal(sends, 1)
  assert.match(state.automation.sparks[0].lastRunDate, /^\d{4}-\d{2}-\d{2}$/)
})

test('missed spark tasks are detected and filled later the same day', async () => {
  const state = {
    automation: {
      autoReply: false,
      blacklist: [],
      sparks: [{ id: 8, name: '小明', time: '00:00', kind: 'text', message: '续火花', enabled: true }],
      dailyLimit: 30,
    },
    sendHistory: [],
    logs: [],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: (entry) => { state.logs.unshift(entry) },
  }
  const service = new DouyinService({ storage, emit: () => {} })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [] })
  service.isLastMessageFromMe = async () => false
  let sends = 0
  service.sendTask = async () => { sends += 1; return { ok: true } }

  await service.runAutomation()

  assert.equal(sends, 1)
  assert.match(state.automation.sparks[0].lastRunDate, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(state.logs[0].type, 'spark_sent')
})

test('spark fill is skipped when our message is already last', async () => {
  const state = {
    automation: {
      autoReply: false,
      blacklist: [],
      sparks: [{ id: 9, name: '小明', time: '00:00', kind: 'text', message: '续火花', enabled: true }],
      dailyLimit: 30,
    },
    sendHistory: [],
    logs: [],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: (entry) => { state.logs.unshift(entry) },
  }
  const service = new DouyinService({ storage, emit: () => {} })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [] })
  service.isLastMessageFromMe = async () => true
  let sends = 0
  service.sendTask = async () => { sends += 1; return { ok: true } }

  await service.runAutomation()

  assert.equal(sends, 0)
  assert.match(state.automation.sparks[0].lastRunDate, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(state.logs[0].type, 'spark_fill_skipped')
})

test('spark fill stays pending when last-message ownership is unknown', async () => {
  const state = {
    automation: {
      autoReply: false,
      blacklist: [],
      sparks: [{ id: 10, name: '小明', time: '00:00', kind: 'text', message: '续火花', enabled: true }],
      dailyLimit: 30,
    },
    sendHistory: [],
    logs: [],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: (entry) => { state.logs.unshift(entry) },
  }
  const service = new DouyinService({ storage, emit: () => {} })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [] })
  service.isLastMessageFromMe = async () => null
  service.sendTask = async () => assert.fail('unknown ownership must never send')

  await service.runAutomation()

  assert.equal(state.automation.sparks[0].lastRunDate, undefined)
  assert.equal(state.logs[0].type, 'spark_fill_check_failed')
})

test('daily send limit does not consume an incoming message', async () => {
  const now = Date.now()
  const state = {
    automation: { autoReply: true, paused: false, blacklist: [], aiDisabledContacts: [], rules: [], sparks: [], dailyLimit: 1 },
    sendHistory: [{ at: new Date(now - 1000).toISOString(), name: 'someone', kind: 'text' }],
    logs: [],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: (entry) => state.logs.unshift(entry),
  }
  const service = new DouyinService({ storage, emit: () => {}, ai: { hasProvider: () => false } })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: 'someone', preview: 'new incoming' }] })
  service.lastSeen.set('someone', 'old incoming')
  service.sendMessage = async () => assert.fail('daily limit must block sending')

  await service.runAutomation()

  assert.equal(service.lastSeen.get('someone'), 'old incoming')
  assert.equal(state.logs[0].type, 'send_blocked')
})

test('paused automation keeps a new message pending until resumed', async () => {
  const state = {
    automation: { autoReply: true, paused: true, blacklist: [], aiDisabledContacts: [], rules: [{ keywords: ['hello'], replyText: 'received' }], sparks: [], dailyLimit: 30 },
    sendHistory: [],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: () => {},
  }
  const service = new DouyinService({ storage, emit: () => {}, ai: { hasProvider: () => false } })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: 'someone', preview: 'hello' }] })
  service.lastSeen.set('someone', 'old')
  const sent = []
  service.sendMessage = async (name, text) => sent.push({ name, text })

  await service.runAutomation()
  assert.equal(service.lastSeen.get('someone'), 'old')
  assert.equal(sent.length, 0)

  state.automation.paused = false
  await service.runAutomation()
  assert.deepEqual(sent, [{ name: 'someone', text: 'received' }])
})

test('re-enabling a contact processes the message that was blocked', async () => {
  const state = {
    automation: { autoReply: true, paused: false, blacklist: [], aiDisabledContacts: ['someone'], rules: [{ keywords: ['hello'], replyText: 'received' }], sparks: [], dailyLimit: 30 },
    sendHistory: [],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: () => {},
  }
  const service = new DouyinService({ storage, emit: () => {}, ai: { hasProvider: () => false } })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: 'someone', preview: 'hello' }] })
  service.lastSeen.set('someone', 'hello')
  const sent = []
  service.sendMessage = async (name, text) => sent.push({ name, text })

  await service.runAutomation()
  state.automation.aiDisabledContacts = []
  await service.runAutomation()

  assert.deepEqual(sent, [{ name: 'someone', text: 'received' }])
})

test('a weak list fromMe=false marker is verified before replying', async () => {
  const state = {
    automation: { autoReply: true, paused: false, blacklist: [], aiDisabledContacts: [], rules: [{ keywords: ['reply'], replyText: 'received' }], sparks: [], dailyLimit: 30 },
    sendHistory: [],
    logs: [],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: (entry) => state.logs.unshift(entry),
  }
  const service = new DouyinService({ storage, emit: () => {}, ai: { hasProvider: () => false } })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: 'someone', preview: 'my reply', fromMe: false }] })
  service.lastSeen.set('someone', 'old')
  service.isLastMessageFromMe = async () => true
  service.sendMessage = async () => assert.fail('our own message must not trigger an automatic reply')

  await service.runAutomation()

  assert.equal(state.logs[0].type, 'auto_skip')
  assert.equal(service.lastSeen.get('someone'), 'my reply')
})

test('missing provider keeps an incoming message pending', async () => {
  const state = {
    automation: { autoReply: true, paused: false, blacklist: [], aiDisabledContacts: [], rules: [], sparks: [], dailyLimit: 30 },
    sendHistory: [],
    logs: [],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
    addLog: (entry) => state.logs.unshift(entry),
  }
  const service = new DouyinService({ storage, emit: () => {}, ai: { hasProvider: () => false } })
  service.window = { isDestroyed: () => false }
  service.getStatus = async () => ({ connected: true })
  service.syncContacts = async () => ({ contacts: [{ name: 'someone', preview: 'hello' }] })
  service.lastSeen.set('someone', 'old')

  await service.runAutomation()

  assert.equal(service.lastSeen.get('someone'), 'old')
  assert.equal(state.logs[0].type, 'ai_unavailable')
})
