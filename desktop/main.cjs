const { app, BrowserWindow, shell, session, dialog } = require('electron')
const path = require('node:path')

const APP_URL = 'https://visionary-nexus-theta.vercel.app'
const APP_ORIGIN = new URL(APP_URL).origin
const API_ORIGIN = 'https://visionary-nexus-api-dyky.onrender.com'
const TRUSTED_AUTH_HOSTS = new Set([
  'accounts.google.com',
  'github.com',
  'login.microsoftonline.com',
  'appleid.apple.com'
])

let mainWindow

app.setName('Visionary Nexus')
app.setAppUserModelId('com.visionarynexus.app')

function isHttpUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:'
  } catch {
    return false
  }
}

function isTrustedAppNavigation(value) {
  try {
    const url = new URL(value)
    return url.origin === APP_ORIGIN ||
      url.origin === API_ORIGIN ||
      TRUSTED_AUTH_HOSTS.has(url.hostname)
  } catch {
    return false
  }
}

function configurePermissions() {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(['media', 'notifications'].includes(permission))
  })
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => {
    return ['media', 'notifications'].includes(permission)
  })
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 620,
    show: false,
    title: 'Visionary Nexus',
    backgroundColor: '#050505',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow.show())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedAppNavigation(url)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true
          }
        }
      }
    }
    if (isHttpUrl(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (isTrustedAppNavigation(targetUrl)) return
    event.preventDefault()
    if (isHttpUrl(targetUrl)) shell.openExternal(targetUrl)
  })

  try {
    await mainWindow.loadURL(APP_URL)
  } catch (error) {
    await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: 'Visionary Nexus is offline',
      message: 'The desktop app could not reach the Visionary Nexus website.',
      detail: 'Check your internet connection and reopen the app.\n\n' + error.message,
      buttons: ['Close']
    })
    app.quit()
  }

  mainWindow.on('closed', () => { mainWindow = null })
}

app.whenReady().then(async () => {
  configurePermissions()
  await createWindow()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
