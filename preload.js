const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  minimizeWindow: () => ipcRenderer.send('minimize-window'),
  maximizeWindow: () => ipcRenderer.send('maximize-window'),
  hideWindow: () => ipcRenderer.send('hide-window'),
  setLoginItem: (openAtLogin) => ipcRenderer.send('set-login-item', openAtLogin),
  updateShortcut: (key) => ipcRenderer.send('update-shortcut', key),
  onTranslate: (callback) => ipcRenderer.on('trigger-translate', (_event, text) => callback(text)),
  
  // 文件操作
  selectFile: () => ipcRenderer.invoke('open-file-dialog'),
  readDroppedFile: (path) => ipcRenderer.invoke('read-file-path', path),
  
  // 本地 OCR 接口
  runLocalOCR: (imagePath) => ipcRenderer.invoke('run-local-ocr', imagePath),
  saveTempImage: (base64) => ipcRenderer.invoke('save-temp-file', base64),

  // 🟢 核心修复：专门用于从 File 对象中提取真实路径
  getFilePath: (file) => {
    try {
      // 尝试使用 Electron 提供的工具获取路径
      return webUtils.getPathForFile(file);
    } catch (e) {
      // 如果工具失效，尝试直接读取 (兼容旧版本)
      return file.path;
    }
  }
});