const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('lumen', {
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),
  getEngineStatus: async () => {
    const res = await ipcRenderer.invoke('engine:status');
    return res && res.ok ? res.data : undefined;
  },
  // 智能体运行事件订阅：返回解绑函数，避免组件卸载后泄漏监听。
  onAgentEvent: (callback) => {
    if (typeof callback !== 'function') return () => {};
    const listener = (_event, envelope) => {
      try {
        callback(envelope);
      } catch (err) {
        console.error('[lumen] agent event handler failed', err);
      }
    };
    ipcRenderer.on('agent:event', listener);
    return () => ipcRenderer.removeListener('agent:event', listener);
  }
});
