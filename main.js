if (require('electron-squirrel-startup')) {
  require('electron').app.quit();
  return;
}

const { app, BrowserWindow, globalShortcut, clipboard, ipcMain, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const { spawn, exec } = require('child_process');
const fs = require('fs');
const os = require('os');
const mammoth = require('mammoth'); 

let win;
let tray = null;
let isQuitting = false;

// 🟢 Python 进程管理变量
let pythonProcess = null;
const ocrQueue = []; 

const statePath = path.join(app.getPath('userData'), 'window-state.json');

function loadState() {
  try {
    const data = fs.readFileSync(statePath, 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return { width: 1200, height: 800 };
  }
}

function saveState() {
  if (!win) return;
  const bounds = win.getBounds();
  try {
    fs.writeFileSync(statePath, JSON.stringify(bounds));
  } catch (e) { console.error(e); }
}

function createWindow() {
  const state = loadState();
  win = new BrowserWindow({
    width: state.width, height: state.height, x: state.x, y: state.y,
    minWidth: 900, minHeight: 600, frame: false, transparent: true, show: false,
    icon: path.join(__dirname, 'logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false
    }
  });

  win.loadFile('index.html');
  
  win.once('ready-to-show', () => {
    win.show();
    // 🟢 启动常驻 Python 引擎
    initPythonEngine();
  });

  ipcMain.on('minimize-window', () => win.minimize());
  ipcMain.on('maximize-window', () => {
    if (win.isMaximized()) win.unmaximize(); else win.maximize();
  });
  ipcMain.on('hide-window', () => win.hide());
  ipcMain.on('set-login-item', (e, open) => app.setLoginItemSettings({ openAtLogin: open, openAsHidden: false }));
  ipcMain.on('update-shortcut', (e, k) => registerShortcut(k));

  ipcMain.handle('read-file-path', async (e, p) => await processFile(p));
  ipcMain.handle('open-file-dialog', async () => {
    const res = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'All', extensions: ['pdf','docx','txt','jpg','png'] }] });
    if (res.canceled || res.filePaths.length === 0) return null;
    return await processFile(res.filePaths[0]);
  });

  // 🟢 核心：发送图片给常驻进程
  ipcMain.handle('run-local-ocr', async (event, imagePath) => {
    return await sendImageToPython(imagePath);
  });

  // 🟢 核心：保存临时文件 (PDF转图用)
  ipcMain.handle('save-temp-file', async (event, base64Data) => {
    try {
      const base64Image = base64Data.split(';base64,').pop();
      const tempPath = path.join(os.tmpdir(), `ocr_temp_${Date.now()}.jpg`);
      fs.writeFileSync(tempPath, base64Image, {encoding: 'base64'});
      return tempPath;
    } catch (e) { return null; }
  });

  win.on('close', (e) => { saveState(); if (!isQuitting) { e.preventDefault(); win.hide(); } });
  win.on('blur', () => win.setAlwaysOnTop(false));
}

// 🟢 启动 Python 引擎 (守护进程模式)
function initPythonEngine() {
  if (pythonProcess) return;

  // 修复 9009 错误：Windows 下优先用 'py'
  const pythonCommand = process.platform === 'win32' ? 'py' : 'python3';
  const scriptPath = path.join(__dirname, 'py_engine', 'ocr_server.py');
  
  console.log(`[OCR System] 正在启动引擎: ${pythonCommand} "${scriptPath}"`);
  
  try {
    pythonProcess = spawn(pythonCommand, [scriptPath]);
    
    // 监听报错 (如找不到命令)
    pythonProcess.on('error', (err) => {
        console.error("启动失败:", err);
        pythonProcess = null;
    });

    pythonProcess.stdout.on('data', (data) => {
      const lines = data.toString().split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        
        // 收到就绪信号
        if (line.trim() === "READY") {
          console.log("[OCR System] 🚀 引擎已就绪！");
          continue;
        }

        // 处理任务结果
        if (ocrQueue.length > 0) {
          try {
            const json = JSON.parse(line);
            const task = ocrQueue.shift(); // 取出最早的任务
            
            if (json.code === 200) {
              task.resolve(json.text);
            } else {
              task.resolve(`[OCR Info] ${json.msg}`);
            }
          } catch (e) {
            // 忽略非 JSON 日志
          }
        }
      }
    });

    pythonProcess.stderr.on('data', (data) => {
      console.log(`[Python Log]: ${data.toString()}`);
    });

    pythonProcess.on('exit', (code) => {
      console.log(`[OCR System] 引擎退出 (Code ${code})`);
      pythonProcess = null;
    });

  } catch (e) {
    console.error("Spawn Error:", e);
  }
}

// 🟢 发送任务给 Python
function sendImageToPython(imagePath) {
  return new Promise((resolve, reject) => {
    if (!pythonProcess) {
      initPythonEngine();
      setTimeout(() => {
          if(!pythonProcess) resolve("[系统错误] Python 引擎启动失败 (Code 9009)，请检查是否安装 Python。");
          else {
              // 重试发送
              ocrQueue.push({ resolve, reject });
              pythonProcess.stdin.write(imagePath + "\n");
          }
      }, 1000);
      return;
    }

    ocrQueue.push({ resolve, reject });
    pythonProcess.stdin.write(imagePath + "\n");
  });
}

// 🟢 文件处理 (修复路径为空导致的崩溃)
async function processFile(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return { type: 'error', content: "无效的文件路径 (可能是网页图片，请先保存到本地)" };
  }

  const ext = path.extname(filePath).toLowerCase();
  try {
    if (['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
      const fileBuffer = fs.readFileSync(filePath);
      return { type: 'image', path: filePath, content: fileBuffer.toString('base64'), mimeType: `image/${ext.replace('.', '')}` };
    } else if (ext === '.pdf') {
      const fileBuffer = fs.readFileSync(filePath);
      return { type: 'pdf', content: fileBuffer.toString('base64'), path: filePath };
    } else if (ext === '.docx') {
      const result = await mammoth.extractRawText({ path: filePath });
      return { type: 'text', content: result.value, path: filePath };
    } else {
      const content = fs.readFileSync(filePath, 'utf8');
      return { type: 'text', content: content, path: filePath };
    }
  } catch (error) { return { type: 'error', content: error.message }; }
}

function createTray() {
  const iconPath = path.join(__dirname, 'logo.png');
  let icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(icon);
  tray.setToolTip('LinguistAI');
  tray.setContextMenu(Menu.buildFromTemplate([{label: '打开', click: showWindow}, {label: '退出', click: ()=>{isQuitting=true;app.quit()}}]));
  tray.on('click', showWindow);
}
function showWindow() {
  if (win.isMinimized()) win.restore();
  win.setAlwaysOnTop(true, "screen-saver"); win.show(); win.focus(); setTimeout(()=>win.setAlwaysOnTop(false),100);
}
function registerShortcut(key) {
  globalShortcut.unregisterAll();
  try {
    globalShortcut.register(key, () => {
      let delay = 0;
      if (key.includes('Alt') || key.includes('Ctrl')) delay = 350;
      setTimeout(() => {
        clipboard.writeText(''); 
        triggerCopyScript(() => pollClipboardAndTranslate());
      }, delay);
    });
  } catch(e){}
}
function triggerCopyScript(callback) {
  if (process.platform === 'win32') {
    const vbsPath = path.join(os.tmpdir(), 'fast_copy.vbs');
    fs.writeFileSync(vbsPath, 'Set WshShell = WScript.CreateObject("WScript.Shell")\nWshShell.SendKeys "^c"');
    exec(`cscript //nologo "${vbsPath}"`, () => { callback(); setTimeout(() => fs.unlink(vbsPath,()=>{}), 1000); });
  } else callback();
}
function pollClipboardAndTranslate() {
  let attempts = 0; const maxAttempts = 20; 
  const intervalId = setInterval(() => {
    attempts++; const text = clipboard.readText();
    if (text && text.trim().length > 0) { clearInterval(intervalId); showWindow(); win.webContents.send('trigger-translate', text); return; }
    if (attempts >= maxAttempts) { clearInterval(intervalId); showWindow(); }
  }, 50); 
}

app.whenReady().then(() => { createWindow(); createTray(); registerShortcut('Alt+Q'); });
app.on('will-quit', () => {
  if (pythonProcess) pythonProcess.kill();
  globalShortcut.unregisterAll();
});