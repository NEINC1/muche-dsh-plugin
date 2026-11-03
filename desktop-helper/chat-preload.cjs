const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('mucheDesktopChat', Object.freeze({
  active: true,
  close: () => ipcRenderer.send('muche:chat-close'),
  // 桌面级语音：全局快捷键在 Electron 主进程，指令经这里进页面；页面回报是否在录音。
  onVoiceCommand: (callback) => {
    const handler = (_event, payload) => callback(payload)
    ipcRenderer.on('muche:voice', handler)
    return () => ipcRenderer.removeListener('muche:voice', handler)
  },
  reportVoiceState: (state) => ipcRenderer.send('muche:voice-state', state),
}))
