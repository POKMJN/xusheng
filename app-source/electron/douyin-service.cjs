const { BrowserWindow, session } = require('electron')

const CHAT_URL = 'https://www.douyin.com/chat?isPopup=1'
const PARTITION = 'persist:douyin-account'
const AUTOMATION_POLL_MS = 1000
const SPARK_RETRY_MS = 5 * 60 * 1000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const localDateKey = (value = new Date()) => {
  const date = value instanceof Date ? value : new Date(value)
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

const normalizeHistoryMessage = (item) => ({
  role: item?.role === 'me' ? 'me' : 'contact',
  text: String(item?.text || '').replace(/\s+/g, ' ').trim().slice(0, 500),
})

const contactMessageKey = (contact) => String(contact?.messageKey || contact?.preview || '')

const isVideoPreview = (value) => /(?:\[?视频\]?|发来一个视频|分享(?:了)?视频|分享(?:了)?作品|video|短视频|视频卡片|来自视频|播放|[▶⏵]|\d{1,3}["”']\s*$|作品|看这个|你看看|发来了一段)/i.test(String(value || ''))
const mediaPreviewKind = (value) => {
  const text = String(value || '')
  if (isVideoPreview(text)) return 'video'
  if (/(?:\[?媒体\]?|媒体卡片|分享\s*@|来自视频)/i.test(text)) return 'share'
  if (/(?:\[?图集\]?|分享\[图集\]|相册)/i.test(text)) return 'album'
  if (/(?:\[?图片\]?|照片|photo|image)/i.test(text)) return 'image'
  if (/(?:\[?动图\]?|GIF)/i.test(text)) return 'gif'
  if (/(?:\[?表情\]?|表情包|emoji)/i.test(text)) return 'sticker'
  if (/(?:分享(?:了)?(?:链接|商品|直播|音乐|作品)|\[分享\])/i.test(text)) return 'share'
  return ''
}

function extractConversationPreview(lines, explicitPreview = '', explicitStreak = '') {
  const preview = String(explicitPreview || '').replace(/\s+/g, ' ').trim()
  if (preview) return preview.slice(0, 180)

  const normalized = (Array.isArray(lines) ? lines : [])
    .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  const streak = String(explicitStreak || '').trim()
  const metadataNumberIndex = normalized.findIndex((value, index) => index > 0 && index <= 2 && /^\d{1,4}$/.test(value))
  return normalized.filter((value, index) => {
    if (index === 0 || value === streak || index === metadataNumberIndex) return false
    return !/^(?:刚刚|昨天|今天|星期[一二三四五六日天]?|\d{1,2}:\d{2}|\d+(?:分钟|小时|天)前|已读|未读)$/.test(value)
  }).join(' ').slice(0, 180)
}

function extractStreakCount(explicitStreak = '', lines = []) {
  const explicit = String(explicitStreak || '').match(/\d+/)
  if (explicit) return Number(explicit[0])
  const labelled = (Array.isArray(lines) ? lines : []).find((value) => /火花|连续\s*\d+\s*天|^\d+\s*天$/.test(String(value)))
  return Number((String(labelled || '').match(/\d+/) || [0])[0])
}

function mergeMessageHistory(previous, visible) {
  const oldMessages = (Array.isArray(previous) ? previous : []).map(normalizeHistoryMessage).filter((item) => item.text)
  const newMessages = (Array.isArray(visible) ? visible : []).map(normalizeHistoryMessage).filter((item) => item.text)
  const same = (left, right) => left.role === right.role && left.text === right.text
  let overlap = 0
  const maximum = Math.min(oldMessages.length, newMessages.length)
  for (let size = maximum; size > 0; size -= 1) {
    if (oldMessages.slice(-size).every((item, index) => same(item, newMessages[index]))) {
      overlap = size
      break
    }
  }
  return [...oldMessages, ...newMessages.slice(overlap)].slice(-80)
}

class DouyinService {
  constructor({ storage, emit, ai }) {
    this.storage = storage
    this.emit = emit
    this.ai = ai
    this.window = null
    this.pollTimer = null
    this.polling = false
    this.lastSeen = new Map()
    this.lastLimitNotice = new Map()
    this.lastSkipNotice = new Map()
    this.blockedContacts = new Set()
    const savedSeen = (this.storage?.get().lastSeenPairs || []).filter(p => Date.now() - p.at < 86400000)
    savedSeen.forEach(p => this.lastSeen.set(p.name, p.preview))
    const savedPairs = (this.storage?.get().lastSentPairs || []).filter(p => Date.now() - p.at < 86400000)
    this.lastSent = new Map(savedPairs.map(p => [p.name, p.text]))
    this.lastReplyTime = new Map()
  }

  ensureWindow(show = false) {
    if (this.window && !this.window.isDestroyed()) {
      if (show) this.window.show()
      return this.window
    }

    this.window = new BrowserWindow({
      width: 1180,
      height: 820,
      minWidth: 900,
      minHeight: 620,
      show,
      title: '抖音账号登录 · 续声',
      autoHideMenuBar: true,
      webPreferences: {
        partition: PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: false,
      },
    })
    // Douyin pages sometimes advertise a Windows-only `bytedance:` deep link.
    // It is not needed for web automation and Windows otherwise shows a Store dialog.
    this.window.webContents.on('will-navigate', (event, url) => {
      if (/^bytedance:/i.test(url)) event.preventDefault()
    })
    this.window.webContents.on('will-redirect', (event, url) => {
      if (/^bytedance:/i.test(url)) event.preventDefault()
    })
    this.window.webContents.on('will-frame-navigate', (event, details) => {
      if (/^bytedance:/i.test(details.url)) event.preventDefault()
    })
    this.window.webContents.setWindowOpenHandler(({ url }) => {
      return /^bytedance:/i.test(url) ? { action: 'deny' } : { action: 'allow' }
    })
    this.window.on('close', (event) => {
      if (!this.window.__forceClose) {
        event.preventDefault()
        this.window.hide()
      }
    })
    this.window.loadURL(CHAT_URL)
    return this.window
  }

  async openLogin() {
    const win = this.ensureWindow(true)
    if (!win.webContents.getURL().startsWith('https://www.douyin.com/')) await win.loadURL(CHAT_URL)
    win.focus()
    return { ok: true }
  }

  async logout() {
    await session.fromPartition(PARTITION).clearStorageData()
    if (this.window && !this.window.isDestroyed()) await this.window.loadURL(CHAT_URL)
    this.lastSeen.clear()
    this.lastSent.clear()
    this.emitEvent('status', await this.getStatus())
    return { ok: true }
  }

  async getStatus() {
    const cookies = await session.fromPartition(PARTITION).cookies.get({ url: 'https://www.douyin.com' })
    // Douyin has used several equivalent session cookie names over time.
    const connected = cookies.some(({ name }) => [
      'sessionid', 'sessionid_ss', 'sid_guard', 'sid_tt', 'uid_tt', 'uid_tt_ss',
      'passport_auth_status', 'passport_auth_status_ss',
    ].includes(name))
    return {
      connected,
      mode: 'local-browser',
      accountWindowOpen: Boolean(this.window && !this.window.isDestroyed()),
      message: connected ? '已保存抖音登录会话' : '请打开登录窗口并扫码',
    }
  }

  async waitForChatReady(timeout = 15000) {
    const win = this.ensureWindow(false)
    if (!win.webContents.getURL().startsWith('https://www.douyin.com/chat')) await win.loadURL(CHAT_URL)
    const started = Date.now()
    while (Date.now() - started < timeout) {
      const ready = await win.webContents.executeJavaScript(`Boolean(document.querySelector('[class*="conversationConversationListwrapper"], [class*="messageEditorimChatEditorContainer"]'))`).catch(() => false)
      if (ready) return win
      await sleep(700)
    }
    throw new Error('抖音聊天页面未加载完成，请在登录窗口确认已经登录并进入私信页')
  }

  async syncContacts() {
    const win = await this.waitForChatReady()
    const contacts = await win.webContents.executeJavaScript(`(() => {
      const wrapper = document.querySelector('[class*="conversationConversationListwrapper"]')
      if (!wrapper) return []
      const extractConversationPreview = ${extractConversationPreview.toString()}
      const extractStreakCount = ${extractStreakCount.toString()}
      const nodes = [...wrapper.querySelectorAll('[class*="conversationConversationItemwrapper"]')]
      const seen = new Set()
      return nodes.map((node) => {
        const lines = (node.innerText || '').split(/\\n+/).map(v => v.trim()).filter(Boolean)
        const image = node.querySelector('img')
        const name = lines[0] || ''
        if (!name || name.length > 40 || seen.has(name)) return null
        seen.add(name)
        const previewNode = node.querySelector('[class*="ConversationItemHinttextBox"]')
        const streakNode = node.querySelector('[class*="commonStreaknormalText"]')
        const streakText = streakNode?.innerText || streakNode?.textContent || ''
        let preview = extractConversationPreview(lines, previewNode?.innerText || previewNode?.textContent || '', streakText)
        const mediaHint = node.querySelector('video, [class*="video" i], [class*="player" i], [class*="sticker" i], [class*="emoji" i], [class*="card" i]')
        if (mediaHint && !/(?:视频|图集|图片|动图|表情|分享|作品|播放|▶|⏵|媒体)/i.test(preview)) preview = '[媒体] ' + (preview || '复合消息')
        const fire = extractStreakCount(streakText, lines)
        const fromMe = lines.slice(1).some(l => /^你[：:]/.test(l.trim())) ? true : null
        const unreadNode = node.querySelector('[class*="unread" i], [data-e2e*="unread" i], [aria-label*="未读"]')
        const unread = (unreadNode?.innerText || unreadNode?.textContent || unreadNode?.getAttribute('aria-label') || '').trim()
        const messageKey = unread ? preview + '\u241f' + unread : preview
        return { id: name, name, avatar: image?.src || '', fire, preview, messageKey, fromMe }
      }).filter(Boolean)
    })()`)
    const savedContacts = this.storage.get().contacts || []
    const savedByName = new Map(savedContacts.map((contact) => [contact.name, contact]))
    const mergedContacts = contacts.map((contact) => ({
      ...(savedByName.get(contact.name) || {}),
      ...contact,
    }))
    this.emitEvent('contacts', { contacts: mergedContacts })
    return { ok: true, contacts: mergedContacts }
  }

  async selectConversation(name) {
    const win = await this.waitForChatReady()
    const point = await win.webContents.executeJavaScript(`(() => {
      const target = ${JSON.stringify(name)}
      const wrapper = document.querySelector('[class*="conversationConversationListwrapper"]')
      if (!wrapper) return null
      const rows = [...wrapper.querySelectorAll('[class*="conversationConversationItemwrapper"]')]
      const row = rows.find(node => ((node.innerText || '').split(/\\n+/)[0] || '').trim() === target)
        || rows.find(node => (node.innerText || '').includes(target))
      if (!row) return null
      const rect = row.getBoundingClientRect()
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
    })()`)
    if (!point) throw new Error(`没有在当前私信列表中找到联系人：${name}`)
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: point.x, y: point.y })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x, y: point.y })
    const started = Date.now()
    let usedDomFallback = false
    while (Date.now() - started < 5000) {
      const selected = await win.webContents.executeJavaScript(`(() => {
        const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]')
        return Boolean(editor && !document.querySelector('[class*="RightPanelEmpty"]'))
      })()`).catch(() => false)
      if (selected) return win
      if (!usedDomFallback && Date.now() - started >= 600) {
        usedDomFallback = true
        await win.webContents.executeJavaScript(`(() => {
          const target = ${JSON.stringify(name)}
          const rows = [...document.querySelectorAll('[class*="conversationConversationItemwrapper"]')]
          const row = rows.find(node => ((node.innerText || '').split(/\\n+/)[0] || '').trim() === target)
          if (!row) return false
          row.click()
          return true
        })()`).catch(() => false)
      }
      await sleep(200)
    }
    throw new Error(`点击联系人后抖音没有打开右侧聊天面板：${name}`)
  }

  // Capture the complete latest incoming media bubble. Douyin share cards often
  // contain a poster image, text and nested video nodes, so selecting the last
  // <img> or <video> alone can capture an avatar or a sticker instead.
  async captureLatestIncomingMedia(name) {
    const win = await this.selectConversation(name)
    await this.waitForEditor(win)
    const media = await win.webContents.executeJavaScript(`(() => {
      document.querySelectorAll('[data-xusheng-media-capture]').forEach((node) => node.removeAttribute('data-xusheng-media-capture'))
      const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]')
      const editorRect = editor?.getBoundingClientRect()
      const selector = '[class*="MessageItem"], [class*="messageItem"], [data-e2e*="message-item"], [data-e2e*="messageItem"]'
      const all = [...document.querySelectorAll(selector)]
      const rows = all.filter((node) => !all.some((parent) => parent !== node && parent.contains(node)))
        .map((node) => {
          const rect = node.getBoundingClientRect()
          let signature = ''
          for (let parent = node, depth = 0; parent && depth < 6; parent = parent.parentElement, depth += 1) signature += ' ' + String(parent.className || '')
          const selfByClass = /MessageItemTextisFromMe|isFromMe|(?:^|[\\s_-])(self|mine|my|right|send|owner)(?:[\\s_-]|$)/i.test(signature)
          const contactByClass = /(?:^|[\\s_-])(other|left|receive|peer)(?:[\\s_-]|$)/i.test(signature)
          const mediaNode = node.querySelector('video, img, [style*="background-image"], [class*="video" i], [class*="image" i], [class*="sticker" i], [class*="emoji" i], [class*="card" i]')
          if (!mediaNode || !rect.width || !rect.height || rect.bottom <= 0 || rect.top >= innerHeight) return null
          const mediaRect = mediaNode.getBoundingClientRect()
          const center = mediaRect.left + mediaRect.width / 2
          const divider = editorRect ? editorRect.left + editorRect.width / 2 : innerWidth * 0.65
          const role = selfByClass ? 'me' : contactByClass ? 'contact' : center > divider ? 'me' : 'contact'
          const video = node.querySelector('video')
          const poster = video?.poster || node.querySelector('img')?.currentSrc || node.querySelector('img')?.src || ''
          const videoUrl = video?.currentSrc || video?.src || video?.querySelector('source')?.src || ''
          const videoRect = video?.getBoundingClientRect()
          return { node, rect, role, top: rect.top, video, poster, videoUrl, videoRect }
        }).filter((item) => item && item.role === 'contact').sort((left, right) => left.top - right.top)
      const selected = rows.at(-1)
      if (!selected) return null
      selected.node.scrollIntoView({ block: 'center', inline: 'nearest' })
      selected.node.setAttribute('data-xusheng-media-capture', 'latest')
      const rect = selected.node.getBoundingClientRect()
      const videoAfterScroll = selected.node.querySelector('video')
      const videoRectAfterScroll = videoAfterScroll?.getBoundingClientRect()
      return {
        isVideo: Boolean(videoAfterScroll),
        duration: videoAfterScroll && Number.isFinite(videoAfterScroll.duration) ? videoAfterScroll.duration : 0,
        videoUrl: /^https?:\\/\\//i.test(selected.videoUrl || '') ? selected.videoUrl : '',
        posterUrl: /^https?:\\/\\//i.test(selected.poster || '') ? selected.poster : '',
        videoRect: videoRectAfterScroll ? {
          x: Math.max(0, Math.floor(videoRectAfterScroll.x)),
          y: Math.max(0, Math.floor(videoRectAfterScroll.y)),
          width: Math.max(1, Math.ceil(Math.min(videoRectAfterScroll.right, innerWidth) - Math.max(0, videoRectAfterScroll.x))),
          height: Math.max(1, Math.ceil(Math.min(videoRectAfterScroll.bottom, innerHeight) - Math.max(0, videoRectAfterScroll.y))),
        } : null,
        rect: {
          x: Math.max(0, Math.floor(rect.x - 8)),
          y: Math.max(0, Math.floor(rect.y - 8)),
          width: Math.max(1, Math.ceil(Math.min(rect.right + 8, innerWidth) - Math.max(0, rect.x - 8))),
          height: Math.max(1, Math.ceil(Math.min(rect.bottom + 8, innerHeight) - Math.max(0, rect.y - 8))),
        },
      }
    })()`).catch(() => null)
    if (!media?.rect?.width || !media?.rect?.height) return []
    const frames = []
    const capture = async (rect = media.rect) => {
      const image = await win.webContents.capturePage(rect)
      if (image.isEmpty()) return
      const size = image.getSize()
      const scale = Math.min(1, 640 / size.width, 640 / size.height)
      const resized = scale < 1 ? image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'good' }) : image
      const frame = `data:image/jpeg;base64,${resized.toJPEG(58).toString('base64')}`
      if (frame.length <= 220_000 && !frames.includes(frame)) frames.push(frame)
    }
    const seek = async (ratio) => win.webContents.executeJavaScript(`new Promise((resolve) => {
      const video = document.querySelector('[data-xusheng-media-capture="latest"] video')
      if (!video) return resolve(false)
      video.pause(); video.muted = true
      const seekNow = () => {
        if (!Number.isFinite(video.duration) || video.duration <= 0) return resolve(false)
        const done = () => { video.removeEventListener('seeked', done); resolve(true) }
        video.addEventListener('seeked', done, { once: true })
        setTimeout(done, 1500)
        video.currentTime = Math.max(0, Math.min(video.duration - 0.05, video.duration * ${Number(ratio)}))
      }
      const source = video.currentSrc || video.src || video.querySelector('source')?.src || ''
      if (video.readyState < 1 && /^https?:\\/\\//i.test(source)) {
        try { video.src = source; video.load() } catch {}
      } else {
        try { video.load() } catch {}
      }
      if (Number.isFinite(video.duration) && video.duration > 0 && video.readyState >= 1) return seekNow()
      const ready = () => { video.removeEventListener('loadedmetadata', ready); seekNow() }
      video.addEventListener('loadedmetadata', ready, { once: true })
      setTimeout(() => { video.removeEventListener('loadedmetadata', ready); seekNow() }, 2500)
    })`).catch(() => false)
    if (media.isVideo) {
      await capture(media.rect)
      for (const ratio of [0.2, 0.68]) { await seek(ratio); await capture(media.videoRect || media.rect) }
    } else {
      await capture()
    }
    // A poster URL is often the cleanest key frame for a Douyin share card.
    // Keep the full video URL out of model payloads because standard
    // OpenAI-compatible chat endpoints do not accept video_url parts.
    if (media.posterUrl && frames.length < 3 && !frames.includes(media.posterUrl)) frames.push(media.posterUrl)
    this.log('media_captured', `已读取 ${name} 发来的媒体消息画面`, { name, frames: frames.length, video: media.isVideo, videoAddressFound: Boolean(media.videoUrl), posterFound: Boolean(media.posterUrl) })
    return frames.slice(0, 3)
  }

  async captureLatestIncomingVideo(name) {
    const win = await this.selectConversation(name)
    await this.waitForEditor(win)
    const media = await win.webContents.executeJavaScript(`(() => {
      document.querySelectorAll('[data-xusheng-video-capture]').forEach((node) => node.removeAttribute('data-xusheng-video-capture'))
      const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]')
      const editorRect = editor?.getBoundingClientRect()
      const candidates = [...document.querySelectorAll('video, img, [style*="background-image"]')].map((node) => {
        const rect = node.getBoundingClientRect()
        let signature = ''
        let parent = node
        for (let depth = 0; parent && depth < 7; parent = parent.parentElement, depth += 1) signature += ' ' + String(parent.className || '')
        const looksLikeMedia = node.tagName === 'VIDEO' || /video|player|play|image|photo|picture|album|gallery|sticker|emoji|gif|share|card|content/i.test(signature) || /background-image/i.test(node.getAttribute('style') || '')
        const looksLikeAvatar = /avatar|userhead|headimage|profilephoto/i.test(signature)
        if (!looksLikeMedia || looksLikeAvatar || rect.width < 72 || rect.height < 48 || rect.bottom <= 0 || rect.top >= innerHeight) return null
        const selfByClass = /MessageItemTextisFromMe|(?:^|[\\s_-])(self|mine|my|right|send|owner)(?:[\\s_-]|$)/i.test(signature)
        const contactByClass = /(?:^|[\\s_-])(other|left|receive|peer)(?:[\\s_-]|$)/i.test(signature)
        const center = rect.left + rect.width / 2
        const divider = editorRect ? editorRect.left + editorRect.width / 2 : innerWidth * 0.65
        const fromMe = selfByClass || (!contactByClass && center > divider)
        if (fromMe) return null
        return { node, rect, isVideo: node.tagName === 'VIDEO', top: rect.top }
      }).filter(Boolean).sort((left, right) => left.top - right.top)
      const selected = candidates.at(-1)
      if (!selected) return null
      selected.node.setAttribute('data-xusheng-video-capture', 'latest')
      const rect = selected.rect
      return {
        isVideo: selected.isVideo,
        duration: selected.isVideo && Number.isFinite(selected.node.duration) ? selected.node.duration : 0,
        rect: {
          x: Math.max(0, Math.floor(rect.x)),
          y: Math.max(0, Math.floor(rect.y)),
          width: Math.max(1, Math.ceil(Math.min(rect.right, innerWidth) - Math.max(0, rect.x))),
          height: Math.max(1, Math.ceil(Math.min(rect.bottom, innerHeight) - Math.max(0, rect.y))),
        },
      }
    })()`).catch(() => null)
    if (!media?.rect?.width || !media?.rect?.height) return []

    const frames = []
    const capture = async () => {
      const image = await win.webContents.capturePage(media.rect)
      if (image.isEmpty()) return
      const size = image.getSize()
      const scale = Math.min(1, 448 / size.width, 320 / size.height)
      const resized = scale < 1 ? image.resize({ width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)), quality: 'good' }) : image
      const frame = `data:image/jpeg;base64,${resized.toJPEG(52).toString('base64')}`
      if (frame.length <= 180_000 && !frames.includes(frame)) frames.push(frame)
    }
    const seek = async (ratio) => win.webContents.executeJavaScript(`new Promise((resolve) => {
      const video = document.querySelector('[data-xusheng-video-capture="latest"]')
      if (!video || video.tagName !== 'VIDEO' || !Number.isFinite(video.duration) || video.duration <= 0) return resolve(false)
      video.pause(); video.muted = true
      const done = () => { video.removeEventListener('seeked', done); resolve(true) }
      video.addEventListener('seeked', done, { once: true })
      setTimeout(done, 1500)
      video.currentTime = Math.max(0, Math.min(video.duration - 0.05, video.duration * ${Number(ratio)}))
    })`).catch(() => false)

    if (media.isVideo && media.duration > 0) {
      for (const ratio of [0.08, 0.5, 0.88]) {
        await seek(ratio)
        await capture()
      }
    } else {
      await capture()
    }
    this.log('video_captured', `已读取 ${name} 发来的视频画面`, { name, frames: frames.length })
    return frames.slice(0, 3)
  }

  async learnConversation(name) {
    if (!name) throw new Error('请选择联系人')
    const win = await this.selectConversation(name)
    await this.waitForEditor(win)
    const visibleMessages = await win.webContents.executeJavaScript(`(() => {
      const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]')
      const editorRect = editor?.getBoundingClientRect()
      const primary = [...document.querySelectorAll('[class*="MessageItemTextcontainer"]')]
      const candidates = primary.length ? primary : [...document.querySelectorAll('[class*="messageItem"], [data-e2e*="message-item"]')]
      const rows = candidates.filter((node, index) => {
        const rect = node.getBoundingClientRect()
        if (!rect.width || !rect.height) return false
        return !candidates.some((other, otherIndex) => otherIndex !== index && other.parentElement === node && other.getBoundingClientRect().height >= rect.height * 0.7)
      }).sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)
      const messages = []
      for (const node of rows) {
        const raw = (node.innerText || '').split(/\\n+/).map((part) => part.trim()).filter(Boolean)
        const text = raw.filter((part) => !/^(已读|未读|\\d{1,2}:\\d{2}|昨天|今天)$/.test(part)).join(' ').replace(/\\s+/g, ' ').trim()
        if (!text || text.length > 500) continue
        let signature = ''
        for (let current = node, depth = 0; current && depth < 4; current = current.parentElement, depth += 1) signature += ' ' + String(current.className || '')
        const selfByClass = /MessageItemTextisFromMe/i.test(signature) || /(?:^|[\\s_-])(self|mine|my|right|send|owner)(?:[\\s_-]|$)/i.test(signature)
        const contactByClass = /(?:^|[\\s_-])(other|left|receive|peer)(?:[\\s_-]|$)/i.test(signature)
        const bubble = node.querySelector('[class*="content"], [class*="text"], [class*="bubble"]') || node
        const rect = bubble.getBoundingClientRect()
        const center = rect.left + rect.width / 2
        const divider = editorRect ? editorRect.left + editorRect.width / 2 : window.innerWidth * 0.65
        const role = selfByClass ? 'me' : contactByClass ? 'contact' : center > divider ? 'me' : 'contact'
        const last = messages[messages.length - 1]
        if (!last || last.role !== role || last.text !== text) messages.push({ role, text })
      }
      return messages.slice(-40)
    })()`).catch((error) => { throw new Error(`读取聊天记录失败：${error.message}`) })
    if (!visibleMessages.length) throw new Error('当前会话没有可学习的文字消息')

    const state = this.storage.get()
    const contacts = [...(state.contacts || [])]
    const index = contacts.findIndex((contact) => contact.name === name)
    const current = index >= 0 ? contacts[index] : { id: name, name }
    const messages = mergeMessageHistory(current.learning?.messages, visibleMessages)
    const learning = this.ai?.analyzeConversation
      ? this.ai.analyzeConversation(messages)
      : { messages, updatedAt: new Date().toISOString() }
    const updated = { ...current, learning }
    if (index >= 0) contacts[index] = updated
    else contacts.push(updated)
    this.storage.update({ contacts })
    this.emitEvent('contacts', { contacts })
    this.log('language_learned', `已更新 ${name} 的聊天风格`, { name, messages: messages.length })
    return { ok: true, contact: updated, learnedMessages: messages.length }
  }

  async captureVisibleMessages(win) {
    if (!win || win.isDestroyed?.()) return []
    return win.webContents.executeJavaScript(`(() => {
      const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]')
      const editorRect = editor?.getBoundingClientRect()
      const primary = [...document.querySelectorAll('[class*="MessageItemTextcontainer"]')]
      const candidates = primary.length ? primary : [...document.querySelectorAll('[class*="messageItem"], [data-e2e*="message-item"]')]
      const rows = candidates.filter((node, index) => {
        const rect = node.getBoundingClientRect()
        if (!rect.width || !rect.height) return false
        return !candidates.some((other, otherIndex) => otherIndex !== index && other.parentElement === node && other.getBoundingClientRect().height >= rect.height * 0.7)
      }).sort((left, right) => left.getBoundingClientRect().top - right.getBoundingClientRect().top)
      const messages = []
      for (const node of rows) {
        const raw = (node.innerText || '').split(/\\n+/).map((part) => part.trim()).filter(Boolean)
        const text = raw.filter((part) => !/^(已读|未读|\\d{1,2}:\\d{2}|昨天|今天)$/.test(part)).join(' ').replace(/\\s+/g, ' ').trim()
        if (!text || text.length > 500) continue
        let signature = ''
        for (let current = node, depth = 0; current && depth < 4; current = current.parentElement, depth += 1) signature += ' ' + String(current.className || '')
        const selfByClass = /MessageItemTextisFromMe/i.test(signature) || /(?:^|[\\s_-])(self|mine|my|right|send|owner)(?:[\\s_-]|$)/i.test(signature)
        const contactByClass = /(?:^|[\\s_-])(other|left|receive|peer)(?:[\\s_-]|$)/i.test(signature)
        const bubble = node.querySelector('[class*="content"], [class*="text"], [class*="bubble"]') || node
        const rect = bubble.getBoundingClientRect()
        const center = rect.left + rect.width / 2
        const divider = editorRect ? editorRect.left + editorRect.width / 2 : window.innerWidth * 0.65
        const role = selfByClass ? 'me' : contactByClass ? 'contact' : center > divider ? 'me' : 'contact'
        const last = messages[messages.length - 1]
        if (!last || last.role !== role || last.text !== text) messages.push({ role, text })
      }
      return messages.slice(-20).map(m => ({ role: m.role, text: m.text }))
    })()`).catch(() => [])
  }

  recordConversationMessage(name, role, text, fallbackContact = {}) {
    const value = String(text || '').replace(/\s+/g, ' ').trim()
    if (!name || !value || !this.storage?.update) return fallbackContact
    const state = this.storage.get()
    const contacts = [...(state.contacts || [])]
    const index = contacts.findIndex((contact) => contact.name === name)
    const current = index >= 0 ? contacts[index] : { ...fallbackContact, id: fallbackContact.id || name, name }
    const messages = mergeMessageHistory(current.learning?.messages, [{ role, text: value }])
    const learning = this.ai?.analyzeConversation
      ? this.ai.analyzeConversation(messages)
      : { messages, updatedAt: new Date().toISOString() }
    const updated = { ...current, learning }
    if (index >= 0) contacts[index] = updated
    else contacts.push(updated)
    this.storage.update({ contacts })
    this.emitEvent('contacts', { contacts })
    return updated
  }

  async waitForEditor(win, timeout = 8000) {
    const started = Date.now()
    while (Date.now() - started < timeout) {
      const editor = await win.webContents.executeJavaScript(`(() => {
        const node = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]')
        return node ? { tag: node.tagName, disabled: Boolean(node.disabled || node.getAttribute('aria-disabled') === 'true'), placeholder: node.getAttribute('placeholder') || node.getAttribute('data-placeholder') || '' } : null
      })()`).catch(() => null)
      if (editor && !editor.disabled) return editor
      await sleep(400)
    }
    throw new Error('已找到联系人，但没有找到可用的私信输入框')
  }

  async sendCurrentInput(win) {
    const before = await win.webContents.executeJavaScript(`(() => ({
      text: (() => { const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]'); return editor ? ('value' in editor ? editor.value : editor.innerText) : '' })(),
    }))()`).catch((error) => { throw new Error(`发送前读取输入框失败：${error.message}`) })
    const normalizeEditorText = (text) => String(text || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim()
    if (!normalizeEditorText(before.text)) throw new Error('发送前输入框为空')
    const point = await win.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('.e2e-send-msg-btn, [class*="messageMsgInputpublishBtn"]')
      if (!button) return null
      const rect = button.getBoundingClientRect()
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
    })()`).catch((error) => { throw new Error(`点击发送按钮失败：${error.message}`) })
    if (!point) throw new Error('没有找到抖音发送按钮')
    win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: point.x, y: point.y })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: point.x, y: point.y })
    // Douyin can acknowledge the click asynchronously; wait long enough to
    // avoid treating a slow successful send as a failure and duplicating it.
    await sleep(5000)
    const after = await win.webContents.executeJavaScript(`(() => ({
      text: (() => { const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]'); return editor ? ('value' in editor ? editor.value : editor.innerText) : '' })(),
    }))()`).catch((error) => { throw new Error(`发送后读取输入框失败：${error.message}`) })
    if (normalizeEditorText(after.text)) throw new Error('发送后抖音没有确认消息已提交')
  }

  async sendEmoji(name, emojiName = '早上好') {
    if (!name || !emojiName) throw new Error('联系人和表情名称不能为空')
    this.assertCanSend(name)
    const win = await this.selectConversation(name)
    await this.waitForEditor(win)
    const beforeCount = await win.webContents.executeJavaScript(`document.querySelectorAll('.MessageItemEmojiimage').length`)
    const opened = await win.webContents.executeJavaScript(`(() => {
      const node = document.querySelector('.messageMsgInputiconAction')
      if (!node) return null
      const rect = node.getBoundingClientRect()
      return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
    })()`)
    if (!opened) throw new Error('没有找到抖音表情按钮')
    win.webContents.sendInputEvent({ type: 'mouseMove', x: opened.x, y: opened.y })
    win.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, x: opened.x, y: opened.y })
    win.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, x: opened.x, y: opened.y })
    await sleep(800)
    const clicked = await win.webContents.executeJavaScript(`(() => {
      const items = [...document.querySelectorAll('.emojiEmojiItememojiItem')]
      const item = items.find((node) => (node.innerText || '').trim() === ${JSON.stringify(emojiName)})
      const target = item?.querySelector('.emojiEmojiItemimgBox')
      if (!target) return false
      target.click()
      return true
    })()`)
    if (!clicked) throw new Error(`没有找到“${emojiName}”表情包`)
    const started = Date.now()
    let sent = false
    while (Date.now() - started < 4000) {
      sent = await win.webContents.executeJavaScript(`(() => {
        const count = document.querySelectorAll('.MessageItemEmojiimage').length
        const panelClosed = !document.querySelector('.componentsemojiim-saas-modal')
        return panelClosed && count > ${Number(beforeCount)}
      })()`)
      if (sent) break
      await sleep(250)
    }
    if (!sent) throw new Error(`抖音没有确认“${emojiName}”表情已发送`)
    this.lastSent.set(name, `[${emojiName}]`)
    this.lastReplyTime.set(name, Date.now())
    const pairs = [...this.lastSent].map(([n, t]) => ({ name: n, text: t, at: Date.now() }))
    this.storage.update({ lastSentPairs: pairs })
    this.recordSuccessfulSend(name, 'emoji')
    this.log('message_sent', `已向 ${name} 发送“${emojiName}”表情`, { name, emoji: emojiName })
    return { ok: true, kind: 'emoji', emojiName }
  }

  async sendTask(name, task) {
    if (task?.kind === 'emoji') return this.sendEmoji(name, task.emojiName || '早上好')
    if (task?.kind === 'combo') {
      await this.sendMessage(name, task?.message || '', { source: 'spark_combo_text' })
      const emoji = await this.sendEmoji(name, task.emojiName || '早上好')
      return { ok: true, kind: 'combo', emojiName: emoji.emojiName, message: task?.message || '' }
    }
    return this.sendMessage(name, task?.message || '')
  }

  async isLastMessageFromMe(name) {
    try {
      const win = await this.selectConversation(name)
      await this.waitForEditor(win)
      const role = await win.webContents.executeJavaScript(`(() => {
        const all = [...document.querySelectorAll('[class*="MessageItem"], [class*="messageItem"], [data-e2e*="message-item"], [data-e2e*="messageItem"]')]
        const rows = all.filter((node) => !all.some((parent) => parent !== node && parent.contains(node)))
          .filter(n => n.getBoundingClientRect().width > 0 && n.getBoundingClientRect().height > 0)
          .sort((a, b) => b.getBoundingClientRect().top - a.getBoundingClientRect().top)
        if (!rows.length) return null
        const last = rows[0]
        let sig = ''
        for (let c = last, d = 0; c && d < 4; c = c.parentElement, d++) sig += ' ' + (c.className || '')
        const me = /isFromMe|MessageItemTextisFromMe/i.test(sig) || /(?:^|[\\s_-])(self|mine|my|right|send)(?:[\\s_-]|$)/i.test(sig)
        const them = /(?:^|[\\s_-])(other|left|receive|peer)(?:[\\s_-]|$)/i.test(sig)
        if (me) return 'me'
        if (them) return 'contact'
        const rect = last.getBoundingClientRect()
        return rect.left + rect.width / 2 > window.innerWidth * 0.5 ? 'me' : 'contact'
      })()`).catch(() => null)
      return role === 'me' ? true : role === 'contact' ? false : null
    } catch (_) { return null }
  }

  async sendMessage(name, text, metadata = {}) {
    if (!name || !String(text).trim()) throw new Error('联系人和消息内容不能为空')
    this.assertCanSend(name)
    const value = String(text).trim()
    const win = await this.selectConversation(name)
    await this.waitForEditor(win)
    const editorState = await win.webContents.executeJavaScript(`(() => {
      const value = ${JSON.stringify(String(text).trim())}
      const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]')
      if (!editor || editor.disabled || editor.getAttribute('aria-disabled') === 'true') return { ok: false }
      const current = 'value' in editor ? editor.value : editor.innerText
      const normalized = [...String(current || '')]
        .filter((character) => ![0x200B, 0x200C, 0x200D, 0xFEFF].includes(character.charCodeAt(0)))
        .join('').trim()
      if (normalized && normalized !== value) return { ok: false, occupied: true, current }
      if (normalized === value) return { ok: true, current }
      editor.focus()
      if ('value' in editor) {
        editor.value = value
      } else {
        const selection = window.getSelection()
        selection.removeAllRanges()
        const range = document.createRange()
        range.selectNodeContents(editor)
        selection.addRange(range)
        if (!document.execCommand('insertText', false, value)) editor.textContent = value
      }
      editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value }))
      const updated = 'value' in editor ? editor.value : editor.innerText
      const normalizedUpdated = [...String(updated || '')]
        .filter((character) => ![0x200B, 0x200C, 0x200D, 0xFEFF].includes(character.charCodeAt(0)))
        .join('').trim()
      return { ok: normalizedUpdated === value, current: updated }
    })()`).catch((error) => { throw new Error(`写入私信输入框失败：${error.message}`) })
    if (editorState?.occupied) throw new Error('输入框中已有未发送内容，已停止自动发送以免覆盖')
    if (!editorState?.ok) {
      const focused = await win.webContents.executeJavaScript(`(() => {
        const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]')
        if (!editor || editor.disabled || editor.getAttribute('aria-disabled') === 'true') return false
        editor.focus()
        if ('select' in editor) editor.select()
        else {
          const selection = window.getSelection()
          const range = document.createRange()
          range.selectNodeContents(editor)
          selection.removeAllRanges()
          selection.addRange(range)
        }
        return true
      })()`).catch(() => false)
      if (focused) {
        await win.webContents.insertText(value)
        await sleep(150)
      }
      const inserted = await win.webContents.executeJavaScript(`(() => {
        const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"], [class*="messageEditorimChatEditorContainer"] textarea, [contenteditable="true"][data-placeholder]')
        const current = editor ? ('value' in editor ? editor.value : editor.innerText) : ''
        return [...String(current || '')].filter(character => ![0x200B, 0x200C, 0x200D, 0xFEFF].includes(character.charCodeAt(0))).join('').trim() === ${JSON.stringify(value)}
      })()`).catch(() => false)
      if (!inserted) throw new Error('私信内容没有成功写入输入框，抖音页面结构可能已经更新')
    }
    try {
      await this.sendCurrentInput(win)
    } catch (error) {
      await win.webContents.executeJavaScript(`(() => {
        const expected = ${JSON.stringify(value)}
        const editor = document.querySelector('[class*="messageEditorimChatEditorContainer"] [contenteditable="true"]')
        const current = [...String(editor?.innerText || '')]
          .filter((character) => ![0x200B, 0x200C, 0x200D, 0xFEFF].includes(character.charCodeAt(0)))
          .join('').trim()
        if (!editor || current !== expected) return false
        editor.focus()
        document.execCommand('selectAll', false, null)
        document.execCommand('delete', false, null)
        editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }))
        return true
      })()`).catch(() => false)
      throw error
    }
    const normalized = value.replace(/\s+/g, ' ').trim()
    this.lastSent.set(name, normalized)
    this.lastSeen.set(name, normalized)
    this.lastReplyTime.set(name, Date.now())
    const pairs = [...this.lastSent].map(([n, t]) => ({ name: n, text: t, at: Date.now() }))
    this.storage.update({ lastSentPairs: pairs })
    this.recordSuccessfulSend(name, 'text')
    this.recordConversationMessage(name, 'me', normalized)
    this.log('message_sent', `已向 ${name} 发送消息`, { name, text: normalized, source: metadata.source || 'manual', ai: Boolean(metadata.ai), model: metadata.model || '', provider: metadata.provider || '', aiLabel: metadata.aiLabel || '' })
    return { ok: true }
  }

  updateAutomation(config) {
    const current = this.storage.get()
    this.storage.update({ automation: { ...current.automation, ...config } })
    this.startWorker()
    return { ok: true }
  }

  getSendAllowance(_name, now = Date.now()) {
    const state = this.storage.get()
    const config = state.automation || {}
    const dailyLimit = Math.max(1, Math.floor(Number(config.dailyLimit ?? 30) || 30))
    const today = localDateKey(now)
    const history = Array.isArray(state.sendHistory) ? state.sendHistory : []
    const sentToday = history.filter((entry) => entry.at && localDateKey(entry.at) === today).length
    if (sentToday >= dailyLimit) {
      return { ok: false, reason: `今天已发送 ${sentToday} 条，达到每日上限 ${dailyLimit} 条`, sentToday, dailyLimit }
    }

    return { ok: true, sentToday, dailyLimit }
  }

  assertCanSend(name) {
    const allowance = this.getSendAllowance(name)
    if (!allowance.ok) throw new Error(allowance.reason)
    return allowance
  }

  recordSuccessfulSend(name, kind) {
    const now = new Date()
    const cutoff = now.getTime() - (8 * 24 * 60 * 60 * 1000)
    const state = this.storage.get()
    const sendHistory = [...(state.sendHistory || []), { at: now.toISOString(), name, kind }]
      .filter((entry) => new Date(entry.at).getTime() >= cutoff)
      .slice(-1000)
    this.storage.update({ sendHistory })
  }

  startWorker() {
    if (this.pollTimer) return
    const scheduleNext = () => {
      const refreshSeconds = Number(this.storage.get().settings?.refreshInterval || 30)
      const delay = Math.max(5000, Math.min(300000, refreshSeconds * 1000))
      this.pollTimer = setTimeout(async () => {
        try { await this.runAutomation() } catch (error) { this.log('worker_error', error.message) }
        if (this.pollTimer) scheduleNext()
      }, delay || AUTOMATION_POLL_MS)
    }
    scheduleNext()
  }

  async runAutomation() {
    if (this.polling) return
    const state = this.storage.get()
    const config = state.automation || {}
    const settings = state.settings || {}
    if (settings.quietHours) {
      const toMinutes = (value) => {
        const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/)
        return match ? Number(match[1]) * 60 + Number(match[2]) : 0
      }
      const now = new Date()
      const current = now.getHours() * 60 + now.getMinutes()
      const start = toMinutes(settings.quietStart || '23:00')
      const end = toMinutes(settings.quietEnd || '07:00')
      const muted = start === end || (start < end ? current >= start && current < end : current >= start || current < end)
      if (muted) return
    }
    const hasWork = Boolean((config.autoReply && !config.paused) || (config.sparks || []).some((task) => task.enabled))
    if (!hasWork) return
    const status = await this.getStatus()
    if (!status.connected) return
    if (!this.window || this.window.isDestroyed()) this.ensureWindow(false)
    this.polling = true
    try {
      const { contacts } = await this.syncContacts()
      const today = localDateKey()
      const blacklist = new Set((config.blacklist || []).map((name) => String(name).trim()).filter(Boolean))
      const aiDisabledContacts = new Set((config.aiDisabledContacts || []).map((name) => String(name).trim()).filter(Boolean))
      const canSend = (name) => !blacklist.has(name) && this.getSendAllowance(name).ok
      for (const contact of contacts) {
        const currentMessageKey = contactMessageKey(contact)
        const previous = this.lastSeen.get(contact.name)
        const hasPrevious = this.lastSeen.has(contact.name)
        if (!contact.preview) {
          this.lastSeen.set(contact.name, currentMessageKey)
          continue
        }
        // Paused/disabled automation must not consume the incoming preview;
        // it should remain eligible when the user resumes automation.
        if (!config.autoReply || config.paused) continue
        const blocked = blacklist.has(contact.name) || aiDisabledContacts.has(contact.name)
        if (blocked) {
          const reason = blacklist.has(contact.name) ? 'blacklist' : 'ai_disabled'
          const noticeKey = `${reason}:${contact.name}:${contact.preview}`
          this.blockedContacts.add(contact.name)
          if (!this.lastSkipNotice.has(noticeKey)) {
            this.lastSkipNotice.set(noticeKey, Date.now())
            this.log('auto_blocked', `Auto reply disabled for ${contact.name}`, { name: contact.name, reason, preview: contact.preview })
          }
          continue
        }
        const reenabled = this.blockedContacts.delete(contact.name)
        // Establish a baseline on the first sync so old conversations are not
        // answered unexpectedly after a fresh install or logout.
        if (!hasPrevious && !reenabled) {
          this.lastSeen.set(contact.name, currentMessageKey)
          continue
        }
        if (previous === currentMessageKey && !reenabled) continue
        if (!canSend(contact.name)) {
          const noticeKey = `${contact.name}:${localDateKey()}`
          if (!this.lastLimitNotice.has(noticeKey)) {
            this.lastLimitNotice.set(noticeKey, Date.now())
            this.log('send_blocked', `已达到每日发送上限，暂不回复 ${contact.name}`, { name: contact.name })
          }
          // Keep lastSeen unchanged so the message is retried after the limit
          // resets instead of being silently discarded.
          continue
        }
        // A positive list marker is useful, but its absence is not proof that
        // the latest message came from the contact. Verify in the chat view.
        const fromMe = contact.fromMe === true ? true : await this.isLastMessageFromMe(contact.name)
        if (fromMe === true) {
          this.log('auto_skip', `${contact.name} 是自己发的，跳过`)
          this.lastSeen.set(contact.name, currentMessageKey)
          continue
        }
        const learnedContact = this.recordConversationMessage(contact.name, 'contact', contact.preview, contact)
        const rule = (config.rules || []).find((item) => item.enabled !== false && (item.keywords || []).some((keyword) => contact.preview.includes(keyword)))
        let replyText = rule?.replyText || ''
        let aiAttempted = false
        let aiDraft = null
        if (!replyText && this.ai?.hasProvider?.()) {
          aiAttempted = true
          try {
            // 进入聊天面板抓取完整消息以增强上下文理解
            let enhancedContact = learnedContact
            try {
              const chatWin = await this.selectConversation(contact.name)
              if (chatWin) {
                const visibleMessages = await this.captureVisibleMessages(chatWin)
                if (visibleMessages.length > 0) {
                  const mergedMessages = mergeMessageHistory(learnedContact.learning?.messages, visibleMessages)
                  const enhancedLearning = this.ai.analyzeConversation(mergedMessages)
                  enhancedContact = { ...learnedContact, learning: enhancedLearning }
                }
              }
            } catch (_) { /* 抓取完整消息失败，回退到预览文本 */ }

            let videoFrames = []
            const mediaKind = mediaPreviewKind(contact.preview)
            const isMedia = Boolean(mediaKind)
            if (isMedia) {
              try {
                videoFrames = await this.captureLatestIncomingMedia(contact.name)
                // Keep the original node-level capture as a fallback for older
                // page layouts where the message wrapper is not discoverable.
                if (!videoFrames.length && this.captureLatestIncomingVideo) videoFrames = await this.captureLatestIncomingVideo(contact.name)
              } catch (_) {}
            }
            if (isMedia) {
              const providers = this.storage.get().providers || []
              const caps = providers.length ? providers.some(p => (p.capabilities || []).includes('vision')) : Boolean(this.ai?.hasProvider?.())
              if (!caps) {
                this.log('media_skipped', `${contact.name} 的媒体消息，模型不支持识别，已跳过`, { name: contact.name, mediaKind })
                this.lastSeen.set(contact.name, currentMessageKey)
                continue
              }
              if (!videoFrames.length) {
                this.log('media_uncertain', `${contact.name} 的媒体消息无法获取画面，已跳过`, { name: contact.name, mediaKind })
                this.lastSeen.set(contact.name, currentMessageKey)
                continue
              }
            }
            aiDraft = await this.ai.draft({ contact: enhancedContact, incoming: contact.preview, videoFrames })
            if (aiDraft?.ok && (aiDraft.labeledText || aiDraft.text)) {
              const model = aiDraft.model || this.storage.get().providers?.[0]?.model || '当前模型'
              const label = aiDraft.aiLabel || `AI · ${model}`
              const generated = String(aiDraft.labeledText || aiDraft.text).trim()
              replyText = generated.startsWith(`【${label}】`) ? generated : `【${label}】${generated}`
            }
          } catch (error) {
            this.log('ai_error', `为 ${contact.name} 调用 AI 失败`, { name: contact.name, error: error.message })
            if (previous === undefined) this.lastSeen.delete(contact.name)
            else this.lastSeen.set(contact.name, previous)
            continue
          }
        }
        if (replyText) {
          try {
            const aiMeta = aiAttempted ? { ai: true, source: 'ai', model: aiDraft?.model || this.storage.get().providers?.[0]?.model || '', provider: aiDraft?.provider || this.storage.get().providers?.[0]?.name || '', aiLabel: aiDraft?.aiLabel || `AI · ${aiDraft?.model || this.storage.get().providers?.[0]?.model || '当前模型'}` } : { source: 'rule' }
            await this.sendMessage(contact.name, replyText, aiMeta)
            this.lastSeen.set(contact.name, currentMessageKey)
          } catch (error) {
            if (previous === undefined) this.lastSeen.delete(contact.name)
            else this.lastSeen.set(contact.name, previous)
            this.log('send_error', `auto reply send failed for ${contact.name}`, { name: contact.name, error: error.message })
          }
          // sendMessage 内部已设 lastSeen，不覆盖
        } else if (aiAttempted) {
          if (previous === undefined) this.lastSeen.delete(contact.name)
          else this.lastSeen.set(contact.name, previous)
          const noticeKey = `ai_empty:${contact.name}:${currentMessageKey}`
          if (!this.lastSkipNotice.has(noticeKey)) {
            this.lastSkipNotice.set(noticeKey, Date.now())
            this.log('ai_empty', `AI 未返回有效回复，保留 ${contact.name} 的消息待重试`, { name: contact.name })
          }
        } else {
          if (previous === undefined) this.lastSeen.delete(contact.name)
          else this.lastSeen.set(contact.name, previous)
          const noticeKey = `ai_unavailable:${contact.name}:${currentMessageKey}`
          if (!this.lastSkipNotice.has(noticeKey)) {
            this.lastSkipNotice.set(noticeKey, Date.now())
            this.log('ai_unavailable', `未配置可用模型，保留 ${contact.name} 的消息`, { name: contact.name })
          }
        }
      }
      // 持久化 lastSeen 到 storage
      const seenArr = [...this.lastSeen].map(([n, p]) => ({ name: n, preview: p, at: Date.now() }))
      if (this.storage?.update) this.storage.update({ lastSeenPairs: seenArr })

      const now = new Date()
      const minutesNow = now.getHours() * 60 + now.getMinutes()
      const timeToMinutes = (value) => {
        const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/)
        if (!match) return Number.POSITIVE_INFINITY
        const hours = Number(match[1])
        const minutes = Number(match[2])
        return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59
          ? hours * 60 + minutes
          : Number.POSITIVE_INFINITY
      }
      const sparks = [...(config.sparks || [])]
      for (let index = 0; index < sparks.length; index += 1) {
        const task = sparks[index]
        const due = timeToMinutes(task.time) <= minutesNow
        const retryReady = !task.lastAttemptAt || (Date.now() - Number(task.lastAttemptAt)) >= SPARK_RETRY_MS
        // 自动补续：应用错过整点、短暂掉线或发送失败时，在当天后续轮询中补发一次。
        if (!task.enabled || !due || task.lastRunDate === today || !retryReady || !canSend(task.name)) continue
        const attempted = { ...task, lastAttemptAt: Date.now() }
        sparks[index] = attempted
        this.storage.update({ automation: { ...this.storage.get().automation, sparks } })
        try {
          const lastMessageFromMe = await this.isLastMessageFromMe(task.name)
          if (lastMessageFromMe === true) {
            sparks[index] = { ...attempted, lastRunDate: today, lastAttemptAt: Date.now() }
            this.storage.update({ automation: { ...this.storage.get().automation, sparks } })
            this.log('spark_fill_skipped', `${task.name} 的最后一条消息已由我方发送，本次无需补续`, { name: task.name, reason: 'already_replied' })
            continue
          }
          if (lastMessageFromMe !== false) {
            this.log('spark_fill_check_failed', `${task.name} 的最后一条消息归属无法确认，本次未发送`, { name: task.name })
            continue
          }
          await this.sendTask(task.name, task)
          sparks[index] = { ...attempted, lastRunDate: today, lastAttemptAt: Date.now() }
          this.storage.update({ automation: { ...this.storage.get().automation, sparks } })
          this.log('spark_sent', `${task.name} 的续火花任务已执行`, { name: task.name, autoFill: true })
        } catch (error) {
          this.log('spark_fill_failed', `${task.name} 的续火花检测补发失败，将稍后重试`, { name: task.name, error: error.message })
        }
      }
    } finally {
      this.polling = false
    }
  }

  log(type, message, detail = {}) {
    const entry = { id: Date.now(), at: new Date().toISOString(), type, message, detail }
    this.storage.addLog(entry)
    this.emitEvent('log', entry)
  }

  emitEvent(type, payload) {
    this.emit?.({ type, payload })
  }

  destroy() {
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null }
    if (this.window && !this.window.isDestroyed()) {
      this.window.__forceClose = true
      this.window.destroy()
    }
  }
}

module.exports = { AUTOMATION_POLL_MS, DouyinService, extractConversationPreview, extractStreakCount, isVideoPreview, mediaPreviewKind, mergeMessageHistory }
