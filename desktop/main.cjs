const { app, BrowserWindow, dialog, shell } = require('electron')
const { spawn } = require('node:child_process')
const path = require('node:path')
const http = require('node:http')

const projectRoot = path.resolve(__dirname, '..')
const frontendRoot = path.join(projectRoot, 'Frontend')
const backendUrl = 'http://127.0.0.1:8000'
const frontendUrl = 'http://127.0.0.1:8443'

let mainWindow
let backendProcess
let frontendProcess
let quitting = false

function isReachable(url) {
  return new Promise((resolve) => {
    const request = http.get(url, (response) => {
      response.resume()
      resolve(response.statusCode < 500)
    })
    request.setTimeout(1200, () => request.destroy())
    request.on('error', () => resolve(false))
  })
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(url, label, timeoutMs = 45000) {
  const started = Date.now()
  while (Date.now() - started < timeoutMs) {
    if (await isReachable(url)) return
    await delay(500)
  }
  throw new Error(label + ' did not become ready at ' + url)
}

function startLocalServices() {
  const python = path.join(projectRoot, '.venv', 'Scripts', 'python.exe')
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'

  backendProcess = spawn(python, [
    '-m', 'uvicorn', 'app.main:app',
    '--host', '127.0.0.1',
    '--port', '8000',
  ], {
    cwd: projectRoot,
    windowsHide: true,
    stdio: 'ignore',
  })
  backendProcess.on('error', (error) => {
    dialog.showErrorBox('Visionary Nexus backend', 'Could not start the local backend: ' + error.message)
  })

  frontendProcess = spawn(npm, [
    'run', 'dev', '--', '--host', '127.0.0.1',
  ], {
    cwd: frontendRoot,
    windowsHide: true,
    stdio: 'ignore',
    shell: process.platform === 'win32',
  })
  frontendProcess.on('error', (error) => {
    dialog.showErrorBox('Visionary Nexus interface', 'Could not start the frontend: ' + error.message)
  })
}

function stopLocalServices() {
  for (const child of [frontendProcess, backendProcess]) {
    if (child && !child.killed) {
      try { child.kill() } catch {}
    }
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    show: false,
    backgroundColor: '#090b12',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url) || /^whatsapp:/i.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  await mainWindow.loadURL(frontendUrl)
  mainWindow.on('closed', () => { mainWindow = null })
}

app.whenReady().then(async () => {
  if (app.isPackaged) {
    await dialog.showMessageBox({
      type: 'info',
      title: 'Desktop packaging is not finished',
      message: 'The development desktop shell is ready, but the standalone installer and bundled backend still need to be built.',
    })
    app.quit()
    return
  }

  try {
    startLocalServices()
    await waitFor(backendUrl + '/api/health', 'FastAPI backend')
    await waitFor(frontendUrl, 'React interface')
    await createWindow()
  } catch (error) {
    await dialog.showMessageBox({
      type: 'error',
      title: 'Visionary Nexus could not start',
      message: error.message,
      detail: 'Check the existing Python environment and frontend dependencies. Your project data has not been changed.',
    })
    app.quit()
  }
})

app.on('before-quit', () => {
  quitting = true
  stopLocalServices()
})
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0 && !quitting) createWindow().catch(() => app.quit())
})
