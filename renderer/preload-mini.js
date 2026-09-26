/* preload для мини-окна: минимальный безопасный мостик */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mini', {
  sync: cb => ipcRenderer.on('mini:sync', (_e, d) => cb(d)),
  action: a => ipcRenderer.send('mini:action', a),
  onFft: cb => ipcRenderer.on('mini:fft', (_e, d) => cb(d))
});
