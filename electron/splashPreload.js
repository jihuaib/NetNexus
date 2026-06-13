const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('startupProgress', {
    onUpdate: callback => {
        const subscription = (_event, payload) => callback(payload);
        ipcRenderer.on('startup-progress', subscription);
        return () => ipcRenderer.removeListener('startup-progress', subscription);
    }
});
