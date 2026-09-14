const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lumen', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  getEngineStatus: async () => {
    const res = await ipcRenderer.invoke('engine:status');
    return res && res.ok ? res.data : undefined;
  }
});
