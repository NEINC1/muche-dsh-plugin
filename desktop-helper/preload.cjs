const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('muche', {
  asset: () => ipcRenderer.invoke('muche:asset'),
  mediaReady: () => ipcRenderer.send('muche:media-ready'),
  mediaError: () => ipcRenderer.send('muche:media-error'),
  interactive: inside => ipcRenderer.send('muche:interactive', inside),
  pointer: kind => ipcRenderer.send('muche:pointer', { kind }),
  // 桌面级语音的状态：主进程把 recording/sending/idle 推过来，立绘自己显示。
  onVoiceState: callback => {
    const handler = (_event, state) => callback(state)
    ipcRenderer.on('muche:voice-state', handler)
    return () => ipcRenderer.removeListener('muche:voice-state', handler)
  },
})
