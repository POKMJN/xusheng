const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const Module = require('node:module')

const originalLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') {
    return {
      safeStorage: {
        decryptString: (value) => value.toString('utf8'),
        encryptString: (value) => Buffer.from(value),
        isEncryptionAvailable: () => true,
      },
    }
  }
  return originalLoad.call(this, request, parent, isMain)
}

const { AiService, buildChatMessages, buildChatPrompt, buildLearningProfile, labelAiReply, timeContext } = require('../electron/ai-service.cjs')
Module._load = originalLoad

test('provider test and draft both call chat completions', async (t) => {
  const requests = []
  const server = http.createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => { body += chunk })
    request.on('end', () => {
      requests.push({ url: request.url, authorization: request.headers.authorization, body: JSON.parse(body) })
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ choices: [{ message: { content: requests.length === 1 ? '连接成功' : '这是 AI 回复' } }] }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())

  const provider = {
    name: '测试模型',
    model: 'test-model',
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    keyCipher: Buffer.from('secret-key').toString('base64'),
  }
  const state = { providers: [provider] }
  const storage = {
    get: () => structuredClone(state),
    addLog: () => {},
  }
  const service = new AiService(storage)

  assert.equal(service.hasProvider(), true)
  assert.deepEqual(await service.test(0), { ok: true, message: '连接测试成功' })
  const draft = await service.draft({ contact: { name: '小明' }, incoming: '你好' })

  assert.equal(draft.text, '这是 AI 回复')
  assert.equal(requests.length, 2)
  assert.equal(requests[0].url, '/v1/chat/completions')
  assert.equal(requests[0].authorization, 'Bearer secret-key')
  assert.equal(requests[1].body.model, 'test-model')
  assert.equal(requests[1].body.messages[1].content, '你好')
  assert.match(requests[1].body.messages[0].content, /不要把自己当成助手、客服或咨询师/)
  assert.equal(requests[1].body.temperature, 0.85)
  assert.equal(requests[1].body.max_tokens, 120)
})

test('setPrimaryProvider moves a model to the front without dropping encrypted keys', () => {
  const state = {
    providers: [
      { name: '备用模型', model: 'backup', baseUrl: 'http://backup', keyCipher: 'backup-key' },
      { name: '主用模型', model: 'primary', baseUrl: 'http://primary', keyCipher: 'primary-key' },
    ],
  }
  const storage = {
    get: () => structuredClone(state),
    update: (patch) => Object.assign(state, patch),
  }
  const service = new AiService(storage)

  const result = service.setPrimaryProvider(1)

  assert.deepEqual(result.providers.map((item) => item.name), ['主用模型', '备用模型'])
  assert.equal(state.providers[0].keyCipher, 'primary-key')
  assert.equal(state.providers[1].keyCipher, 'backup-key')
  assert.equal(result.providers[0].keyCipher, undefined)
})

test('chat prompt uses profile examples as the highest-priority voice reference', () => {
  const prompt = buildChatPrompt({
    name: '小明',
    profile: {
      relation: '老同学',
      call: '明哥',
      preferences: '爱打游戏',
      boundary: '不聊收入',
      examples: ['笑死我了', ' 行吧到时候再看 '],
    },
  })

  assert.match(prompt, /账号本人/)
  assert.match(prompt, /对方说得短，你也说得短/)
  assert.match(prompt, /不要每次都称呼对方/)
  assert.match(prompt, /笑死我了/)
  assert.match(prompt, /行吧到时候再看/)
  assert.match(prompt, /不聊收入/)
})

test('learned conversation produces style summaries and real chat roles', () => {
  const learning = buildLearningProfile([
    { role: 'contact', text: '在吗' },
    { role: 'me', text: '在啊咋了' },
    { role: 'contact', text: '哈哈哈没事呀' },
    { role: 'me', text: '笑死 你吓我一跳' },
    { role: 'contact', text: '晚上打游戏吗' },
  ])
  const contact = { name: '小明', learning }
  const messages = buildChatMessages(contact, '晚上打游戏吗')

  assert.equal(learning.messages.length, 5)
  assert.match(learning.contactStyle.summary, /偏短句/)
  assert.match(learning.contactStyle.summary, /笑声表达/)
  assert.deepEqual(messages.slice(1).map((item) => item.role), ['user', 'assistant', 'user', 'assistant', 'user'])
  assert.equal(messages.at(-1).content, '晚上打游戏吗')
  assert.match(messages[0].content, /自动学习到的对方说话特点/)
})

test('video replies use a compact prompt and at most three low-detail frames', () => {
  const frames = Array.from({ length: 4 }, (_, index) => `data:image/jpeg;base64,frame${index}`)
  const messages = buildChatMessages({
    name: '小明',
    profile: { relation: '朋友', examples: ['笑死我了'] },
    learning: { ownerStyle: { summary: '偏短句' }, messages: Array.from({ length: 10 }, (_, index) => ({ role: index % 2 ? 'me' : 'contact', text: `历史消息${index}` })) },
  }, '[视频]', frames)

  assert.match(messages[0].content, /请看懂对方刚发的视频画面/)
  assert.equal(messages.length, 6)
  assert.equal(messages.at(-1).content.filter((part) => part.type === 'image_url').length, 3)
  assert.ok(messages.at(-1).content.filter((part) => part.type === 'image_url').every((part) => part.image_url.detail === 'low'))
})

test('AI replies expose a model label while preserving natural response text', () => {
  assert.equal(labelAiReply('凌晨了还没睡呀', { model: 'gpt-5.5' }), '【AI · gpt-5.5】凌晨了还没睡呀')
  assert.equal(labelAiReply('【AI · gpt-5.5】已经标注', { model: 'gpt-5.5' }), '【AI · gpt-5.5】已经标注')
})

test('time context provides a midnight cue for natural replies', () => {
  const context = timeContext(new Date('2026-07-22T01:30:00+08:00'))
  assert.equal(context.label, '凌晨')
  assert.match(context.cue, /没睡/)
})

test('retryable model responses are retried once before succeeding', async (t) => {
  let calls = 0
  const server = http.createServer((_request, response) => {
    calls += 1
    if (calls === 1) { response.writeHead(503, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: 'busy' } })); return }
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ choices: [{ message: { content: '收到啦' } }] }))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const storage = {
    get: () => ({ providers: [{ name: 'Retry', model: 'retry-model', baseUrl: `http://127.0.0.1:${server.address().port}`, keyCipher: Buffer.from('key').toString('base64') }] }),
    addLog: () => {},
  }
  const result = await new AiService(storage).draft({ contact: { name: '小明' }, incoming: '在吗' })
  assert.equal(result.text, '收到啦')
  assert.equal(calls, 2)
})

test('draft fails over to the next configured provider', async (t) => {
  const servers = []
  const makeServer = (status, content) => {
    const server = http.createServer((_request, response) => {
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(status >= 400 ? { error: { message: 'offline' } } : { choices: [{ message: { content } }] }))
    })
    servers.push(server)
    return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
  }
  const first = await makeServer(503, '')
  const second = await makeServer(200, '备用模型回复')
  t.after(() => servers.forEach((server) => server.close()))
  const key = Buffer.from('key').toString('base64')
  const storage = {
    get: () => ({ providers: [
      { name: 'Primary', model: 'primary', baseUrl: `http://127.0.0.1:${first.address().port}`, keyCipher: key },
      { name: 'Backup', model: 'backup', baseUrl: `http://127.0.0.1:${second.address().port}`, keyCipher: key },
    ] }),
    addLog: () => {},
  }
  const result = await new AiService(storage).draft({ contact: { name: '小明' }, incoming: '还在吗' })
  assert.equal(result.text, '备用模型回复')
  assert.equal(result.model, 'backup')
  assert.equal(result.provider, 'Backup')
})
