'use strict'

// Sandboxed preload: expose only the log channel from the main process to the
// loading page, over a contextBridge-isolated world (no node integration).
// Only the local loading page (file:) gets the bridge; the real dsh web page
// is served over http and must not see this shell API.

const { contextBridge, ipcRenderer } = require('electron')

if (window.location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('desktop', {
    onLog: (callback) => {
      ipcRenderer.on('desktop:log', (_event, line) => callback(line))
    },
  })
}
