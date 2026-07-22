const fs = require('node:fs')
const path = require('node:path')

const defaults = {
  automation: { autoReply: false, rules: [], sparks: [], dailyLimit: 30, blacklist: [], aiDisabledContacts: [] },
  contacts: [],
  providers: [],
  profiles: [],
  logs: [],
  sendHistory: [],
  settings: {
    launchOnStartup: false, startMinimized: false, minimizeToTray: true, confirmBeforeSend: true,
    desktopNotifications: true, soundNotifications: false, notifyOnSuccess: true, notifyOnFailure: true,
    autoLearnContacts: true, refreshInterval: '30', quietHours: false, quietStart: '23:00', quietEnd: '07:00',
    saveLogs: true, logRetention: '30',
  },
}

class JsonStorage {
  constructor(userDataPath) {
    this.filePath = path.join(userDataPath, 'state.json')
    this.state = this.read()
  }

  read() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
      const savedAutomation = saved.automation || {}
      // Older builds accidentally sent all top-level patches through the
      // automation IPC handler. Fold those fields back into their proper
      // locations when the app starts so existing data is not lost.
      const nestedAutomation = savedAutomation.automation || {}
      const contacts = (saved.contacts && saved.contacts.length)
        ? saved.contacts
        : (savedAutomation.contacts || [])
      const legacyAiDisabledContacts = Array.isArray(savedAutomation.aiDisabledContacts)
        ? savedAutomation.aiDisabledContacts
        : (savedAutomation.blacklist || [])
      const automation = {
        ...defaults.automation,
        ...savedAutomation,
        ...nestedAutomation,
        aiDisabledContacts: legacyAiDisabledContacts,
        // Previous builds used blacklist for the per-contact AI switch,
        // which also blocked spark tasks. The dedicated field fixes that.
        blacklist: Array.isArray(savedAutomation.aiDisabledContacts) ? (savedAutomation.blacklist || []) : [],
      }
      delete automation.contacts
      delete automation.automation
      return {
        ...structuredClone(defaults),
        ...saved,
        settings: { ...defaults.settings, ...(saved.settings || {}) },
        contacts,
        automation,
        sendHistory: Array.isArray(saved.sendHistory)
          ? saved.sendHistory
          : (saved.logs || [])
            .filter((entry) => entry.type === 'message_sent' && entry.at && entry.detail?.name)
            .map((entry) => ({ at: entry.at, name: entry.detail.name })),
      }
    } catch {
      return structuredClone(defaults)
    }
  }

  get() {
    return structuredClone(this.state)
  }

  update(patch) {
    this.state = { ...this.state, ...patch }
    const tempPath = `${this.filePath}.tmp`
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(tempPath, JSON.stringify(this.state, null, 2), 'utf8')
      fs.renameSync(tempPath, this.filePath)
    } catch (writeError) {
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath) } catch { /* ignore cleanup errors */ }
      // If the primary path is still readable, keep the old state rather than crashing
      try { JSON.parse(fs.readFileSync(this.filePath, 'utf8')); return this.get() } catch {}
      throw writeError
    }
    return this.get()
  }

  addLog(entry) {
    const settings = { ...defaults.settings, ...(this.state.settings || {}) }
    if (!settings.saveLogs) return this.get()
    const retentionDays = Math.max(0, Number(settings.logRetention) || 0)
    const cutoff = retentionDays ? Date.now() - (retentionDays * 24 * 60 * 60 * 1000) : 0
    const logs = [{ id: Date.now(), at: new Date().toISOString(), ...entry }, ...(this.state.logs || [])]
      .filter((item) => !cutoff || new Date(item.at).getTime() >= cutoff)
      .slice(0, 200)
    return this.update({ logs })
  }
}

module.exports = { JsonStorage }
