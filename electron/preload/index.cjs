const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lumen', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  getEngineStatus: () => ipcRenderer.invoke('engine:status')
});
