providers=function(){const ps=state.data.providers||[];return shell(header('模型提供商','使用 OpenAI 兼容接口；密钥由 Electron safeStorage 加密保存。',`<button class="btn primary" data-add-provider>添加提供商</button>`)+`<div class="grid"><section class="panel span-5"><div class="panel-head"><div><h2>已配置提供商</h2><p>配置错误时可以编辑或删除</p></div></div>${ps.length?`<div class="list">${ps.map((x,i)=>`<div class="row provider-row"><div class="icon blue">◇</div><div class="row-main"><strong>${esc(x.name)}</strong><span>${esc(x.baseUrl)} · ${esc(x.model)}</span></div><span class="tag">${x.capabilities?.includes('vision')?'视觉':'文本'}</span><div class="provider-actions"><button class="btn ghost" data-test-provider="${i}">测试</button><button class="btn ghost" data-edit-provider="${i}" title="编辑提供商" aria-label="编辑提供商">✎</button><button class="btn ghost" data-delete-provider="${i}" title="删除提供商" aria-label="删除提供商">×</button></div></div>`).join('')}</div>`:`<div class="empty">还没有提供商。可添加 Maxtab、OpenAI 兼容网关或本地 Ollama。</div>`}</section><section class="panel span-7"><div class="panel-head"><div><h2 id="provider-form-title">添加提供商</h2><p>编辑时 API Key 留空会保留原密钥</p></div></div><div class="form"><div class="cols"><label>显示名称<input id="provider-name" placeholder="Maxtab" /></label><label>模型名称<input id="provider-model" placeholder="qwen3-32b" /></label></div><label>接口地址<input id="provider-url" placeholder="https://api.example.com/v1" /></label><label>API Key<input id="provider-key" type="password" placeholder="只在本机加密保存" /></label><label>能力<select id="provider-cap"><option value="text">文本</option><option value="vision">文本 + 图片 / 视频关键帧</option></select></label><div class="split"><button class="btn" data-cancel-provider style="display:none">取消编辑</button><button class="btn primary" data-save-provider>保存提供商</button></div></div></section></div>`)}

sparks=function(){const tasks=state.data.automation.sparks||[],contacts=state.data.contacts||[];return shell(header('续火花任务','按联系人和时间发送固定消息，也可立即发送。')+`<div class="grid"><section class="panel span-5"><div class="panel-head"><div><h2>新增任务</h2><p>每天同一时间最多执行一次</p></div><span class="tag">${tasks.length} 个任务</span></div><div class="form"><label>联系人<select id="spark-name">${contacts.length?contacts.map(c=>`<option value="${esc(c.name)}">${esc(c.name)}</option>`).join(''):'<option value="">请先同步联系人</option>'}</select></label><div class="cols"><label>回复类型<select id="spark-kind"><option value="emoji">表情包 · 早上好</option><option value="text">文字消息</option></select></label><label>表情包<select id="spark-emoji"><option>早上好</option><option>晚上好</option><option>早点睡</option><option>续火花</option></select></label></div><div class="cols"><label>执行时间<input id="spark-time" type="time" value="20:00" /></label><label>状态<select id="spark-enabled"><option value="true">启用</option><option value="false">停用</option></select></label></div><label>文字内容（文字模式使用）<textarea id="spark-message" placeholder="文字模式填写内容">今天也来续个火花呀～</textarea></label><button class="btn primary" data-save-spark ${contacts.length?'':'disabled'}>保存续火花任务</button></div></section><section class="panel span-7"><div class="panel-head"><div><h2>已配置任务</h2><p>立即发送会使用正式发送流程并再次确认</p></div></div>${tasks.length?`<div class="list">${tasks.map((task,index)=>`<div class="row"><div class="icon ${task.enabled?'green':'blue'}">✦</div><div class="row-main"><strong>${esc(task.name)}</strong><span>每天 ${esc(task.time||'未设置')} · ${task.kind==='emoji'?`表情包：${esc(task.emojiName||'早上好')}`:esc(task.message||'')}</span></div><span class="tag">${task.enabled?'启用':'停用'}</span><button class="btn ghost" data-run-spark="${index}">立即发送</button><button class="btn ghost" data-toggle-spark="${index}">${task.enabled?'停用':'启用'}</button><button class="btn ghost" data-delete-spark="${index}">删除</button></div>`).join('')}</div>`:`<div class="empty">当前没有任务，所以不会发送任何续火花消息。请先在左侧保存任务。</div>`}</section></div>`)}

messages=function(){
  const contacts=state.data.contacts||[],blocked=new Set(state.data.automation.blacklist||[])
  const selected=contacts.find(contact=>contact.name===state.selected)||contacts[0]
  if(selected)state.selected=selected.name
  const rows=contacts.map(contact=>`<div class="row" style="background:${selected?.name===contact.name?'#fff4f1':'transparent'}"><button class="row-main" style="border:0;background:transparent;text-align:left;cursor:pointer" data-select="${esc(contact.name)}"><strong>${esc(contact.name)}</strong><span>${esc(contact.preview||'')}</span></button><button class="btn ghost" data-toggle-ai-contact="${esc(contact.name)}" title="切换该联系人的 AI 自动回复">${blocked.has(contact.name)?'AI 关':'AI 开'}</button></div>`).join('')
  return shell(header('私信与拟回复','先生成草稿检查，再由本机抖音执行器发送。',`<button class="btn" data-sync>同步联系人</button>`)+`<div class="grid"><section class="panel span-4"><div class="panel-head"><div><h2>联系人</h2><p>可按联系人独立开关 AI</p></div></div>${rows?`<div class="list">${rows}</div>`:'<div class="empty">请先同步联系人</div>'}</section><section class="panel span-8"><div class="panel-head"><div><h2>${selected?esc(selected.name):'选择联系人'}</h2><p>${selected?'可绑定独立模型、语气和回复禁区':'登录后选择一位联系人'}</p></div>${selected?`<span class="tag">${blocked.has(selected.name)?'AI 已关闭':'AI 已开启'}</span>`:''}</div>${selected?`<div class="form"><label>收到的文字或视频说明<textarea id="incoming" placeholder="粘贴对方消息；视频可填写可访问的播放地址"></textarea></label><div class="video-box"><strong>视频消息分析</strong><span class="muted">输入视频地址后，AI 会按关键帧、标题和语音转文字生成草稿。</span><input id="videoUrl" placeholder="可选：视频播放地址" /></div><div class="split"><span class="muted">生成前会应用联系人画像和安全限制</span><button class="btn primary" data-draft>生成 AI 拟回复</button></div><div id="reply" class="reply">等待生成草稿</div><div class="split"><button class="btn" data-send>发送当前草稿</button><span class="muted">发送成功后记录实际发送时间</span></div></div>`:'<div class="empty">没有可编辑的联系人</div>'}</section></div>`)
}

const enhancedBaseRender=render
render=function(){
  enhancedBaseRender()
  if(state.section==='messages'){
    document.querySelectorAll('[data-toggle-ai-contact]').forEach(button=>button.onclick=async(event)=>{
      event.stopPropagation()
      const name=button.dataset.toggleAiContact,blacklist=new Set(state.data.automation.blacklist||[])
      if(blacklist.has(name))blacklist.delete(name);else blacklist.add(name)
      await save({automation:{...state.data.automation,blacklist:[...blacklist]}})
    })
  }
  if(state.section==='sparks'){
    const saveButton=document.querySelector('[data-save-spark]')
    if(saveButton)saveButton.onclick=async()=>{
      const name=document.getElementById('spark-name').value,time=document.getElementById('spark-time').value,kind=document.getElementById('spark-kind').value,emojiName=document.getElementById('spark-emoji').value,message=document.getElementById('spark-message').value.trim(),enabled=document.getElementById('spark-enabled').value==='true'
      if(!name||!time||(kind==='text'&&!message)){notify('请填写联系人、时间和消息内容');return}
      const sparks=[...(state.data.automation.sparks||[]),{id:Date.now(),name,time,kind,emojiName,message,enabled}]
      await save({automation:{...state.data.automation,sparks}})
    }
    document.querySelectorAll('[data-run-spark]').forEach(button=>button.onclick=async()=>{
      const task=state.data.automation.sparks?.[Number(button.dataset.runSpark)]
      const description=task.kind==='emoji'?`表情包：${task.emojiName||'早上好'}`:task.message
      if(!task)return
      if(state.data.settings?.confirmBeforeSend!==false&&!confirm(`立即向“${task.name}”发送：\n\n${description}`))return
      try{await D.douyin.sendTask(task.name,task);notify('消息已发送，已写入运行审计')}catch(error){notify(`发送失败：${error?.message||String(error)}`)}
    })
  }
  if(state.section==='providers'){
    const saveButton=document.querySelector('[data-save-provider]')
    const cancelButton=document.querySelector('[data-cancel-provider]')
    const resetForm=()=>{
      for(const id of ['provider-name','provider-model','provider-url','provider-key'])document.getElementById(id).value=''
      document.getElementById('provider-cap').value='text'
      delete saveButton.dataset.providerIndex
      saveButton.textContent='保存提供商'
      cancelButton.style.display='none'
      document.getElementById('provider-form-title').textContent='添加提供商'
    }
    document.querySelectorAll('[data-edit-provider]').forEach(button=>button.onclick=()=>{
      const index=Number(button.dataset.editProvider),provider=state.data.providers?.[index]
      if(!provider)return
      document.getElementById('provider-name').value=provider.name||''
      document.getElementById('provider-model').value=provider.model||''
      document.getElementById('provider-url').value=provider.baseUrl||''
      document.getElementById('provider-key').value=''
      document.getElementById('provider-cap').value=provider.capabilities?.includes('vision')?'vision':'text'
      saveButton.dataset.providerIndex=String(index)
      saveButton.textContent='保存修改'
      cancelButton.style.display='inline-flex'
      document.getElementById('provider-form-title').textContent=`编辑 ${provider.name}`
      document.getElementById('provider-name').focus()
    })
    cancelButton.onclick=resetForm
    saveButton.onclick=async()=>{
      const index=saveButton.dataset.providerIndex
      const provider={name:document.getElementById('provider-name').value.trim(),model:document.getElementById('provider-model').value.trim(),baseUrl:document.getElementById('provider-url').value.trim(),apiKey:document.getElementById('provider-key').value,capabilities:[document.getElementById('provider-cap').value]}
      if(index!==undefined)provider.index=Number(index)
      if(!provider.name||!provider.model||!provider.baseUrl){notify('请填写名称、模型和接口地址');return}
      const result=await D.ai.saveProvider(provider)
      if(!result?.ok){notify(result?.error||'保存失败');return}
      state.data.providers=result.providers||[]
      notify(index===undefined?'提供商已加密保存':'提供商修改已保存')
    }
    document.querySelectorAll('[data-delete-provider]').forEach(button=>button.onclick=async()=>{
      const index=Number(button.dataset.deleteProvider),provider=state.data.providers?.[index]
      if(!provider||!confirm(`确定删除模型提供商“${provider.name}”吗？`))return
      const result=await D.ai.deleteProvider(index)
      if(!result?.ok){notify(result?.error||'删除失败');return}
      state.data.providers=result.providers||[]
      notify('提供商已删除')
    })
    document.querySelectorAll('[data-test-provider]').forEach(button=>button.onclick=async()=>{
      try{const result=await D.ai.testProvider(Number(button.dataset.testProvider));if(result?.ok)notify('连接测试成功，开启自动回复后将使用此 AI');else notify(result?.message||'测试失败')}catch(error){notify(`测试失败：${error?.message||String(error)}`)}
    })
  }
}
