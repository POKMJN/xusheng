const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { JsonStorage } = require('../electron/storage.cjs')

test('legacy contact AI blacklist migrates without blocking spark tasks', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xusheng-storage-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({
    automation: { autoReply: true, blacklist: ['小明'] },
  }))

  const state = new JsonStorage(directory).get()

  assert.deepEqual(state.automation.aiDisabledContacts, ['小明'])
  assert.deepEqual(state.automation.blacklist, [])
})

test('legacy message logs migrate into persistent send history', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xusheng-storage-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({
    logs: [{ type: 'message_sent', at: '2026-07-19T10:00:00.000Z', detail: { name: '小明' } }],
  }))

  const state = new JsonStorage(directory).get()

  assert.deepEqual(state.sendHistory, [{ at: '2026-07-19T10:00:00.000Z', name: '小明' }])
})

test('saved settings merge with new defaults', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xusheng-storage-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  fs.writeFileSync(path.join(directory, 'state.json'), JSON.stringify({
    settings: { desktopNotifications: false },
  }))

  const state = new JsonStorage(directory).get()

  assert.equal(state.settings.desktopNotifications, false)
  assert.equal(state.settings.minimizeToTray, true)
  assert.equal(state.settings.logRetention, '30')
})

test('disabled log storage does not persist new entries', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xusheng-storage-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const storage = new JsonStorage(directory)
  storage.update({ settings: { ...storage.get().settings, saveLogs: false } })

  storage.addLog({ type: 'message_sent', message: 'sent' })

  assert.deepEqual(storage.get().logs, [])
})
