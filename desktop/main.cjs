const { app, BrowserWindow, shell, session, dialog } = require('electron')
const path = require('node:path')
const APP_URL = 'https://visionary-nexus-theta.vercel.app'
const APP_ORIGIN = new URL(APP_URL).origin
const API_ORIGIN = 'https://visionary-nexus-api-dyky.onrender.com'
const OAUTH_SCHEME = 'visionarynexus'
const TRUSTED_AUTH_HOSTS = new Set(['accounts.google.com','github.com','login.microsoftonline.com','appleid.apple.com'])
const OAUTH_PROVIDERS = new Set(['google','facebook','apple','microsoft','github'])
let mainWindow
let pendingOAuthUrl = null
app.setName('Visionary Nexus')
app.setAppUserModelId('com.visionarynexus.app')
function isHttpUrl(value) {
  try { const url = new URL(value); return url.protocol === 'https:' || url.protocol === 'http:' } catch { return false }
}
function isTrustedAppNavigation(value) {
  try { const url = new URL(value); return url.origin === APP_ORIGIN || url.origin === API_ORIGIN || TRUSTED_AUTH_HOSTS.has(url.hostname) } catch { return false }
}
function openOAuthInBrowser(value) {
  try {
    const url = new URL(value)
    const match = url.pathname.match(/^\/api\/auth\/oauth\/([a-z]+)\/start$/)
    if (url.origin !== API_ORIGIN || !match || !OAUTH_PROVIDERS.has(match[1])) return false
    url.searchParams.set('frontend_origin', OAUTH_SCHEME + '://auth')
    shell.openExternal(url.toString())
    return true
  } catch { return false }
}
function handleOAuthDeepLink(value) {
  if (typeof value !== 'string' || !value.startsWith(OAUTH_SCHEME + '://')) return false
  try {
    const url = new URL(value)
    if (url.protocol !== OAUTH_SCHEME + ':' || url.hostname !== 'auth' || url.pathname !== '/auth/callback') return false
    const ticket = url.searchParams.get('oauth_ticket')
    const error = url.searchParams.get('oauth_error')
    if ((!ticket || ticket.length < 30) && !error) return false
    pendingOAuthUrl = APP_URL + '/' + (ticket ? '?oauth_ticket=' + encodeURIComponent(ticket) : '?oauth_error=' + encodeURIComponent(error || 'failed'))
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.loadURL(pendingOAuthUrl)
      pendingOAuthUrl = null
      mainWindow.show()
      mainWindow.focus()
    }
    return true
  } catch { return false }
}
function configurePermissions() {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => callback(['media','notifications'].includes(permission)))
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => ['media','notifications'].includes(permission))
}
async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440, height: 920, minWidth: 900, minHeight: 620, show: false,
    title: 'Visionary Nexus', backgroundColor: '#050505', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true }
  })
  mainWindow.once('ready-to-show', () => {
    mainWindow.show()
    if (pendingOAuthUrl) { mainWindow.loadURL(pendingOAuthUrl); pendingOAuthUrl = null }
  })
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (openOAuthInBrowser(url)) return { action: 'deny' }
    if (isTrustedAppNavigation(url)) return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } } }
    if (isHttpUrl(url)) shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, targetUrl) => {
    if (openOAuthInBrowser(targetUrl)) { event.preventDefault(); return }
    if (isTrustedAppNavigation(targetUrl)) return
    event.preventDefault()
    if (isHttpUrl(targetUrl)) shell.openExternal(targetUrl)
  })
  try { await mainWindow.loadURL(APP_URL) } catch (error) {
    await dialog.showMessageBox(mainWindow, { type: 'warning', title: 'Visionary Nexus is offline', message: 'The desktop app could not reach the Visionary Nexus website.', detail: 'Check your internet connection and reopen the app.\n\n' + error.message, buttons: ['Close'] })
    app.quit()
  }
  mainWindow.on('closed', () => { mainWindow = null })
}
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', (_event, commandLine) => {
    const link = commandLine.find(value => value.startsWith(OAUTH_SCHEME + '://'))
    if (link) handleOAuthDeepLink(link)
    if (mainWindow && !mainWindow.isDestroyed()) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.show(); mainWindow.focus() }
  })
  app.on('open-url', (event, url) => { event.preventDefault(); handleOAuthDeepLink(url) })
  app.whenReady().then(async () => {
    app.setAsDefaultProtocolClient(OAUTH_SCHEME)
    configurePermissions()
    const link = process.argv.find(value => value.startsWith(OAUTH_SCHEME + '://'))
    if (link) handleOAuthDeepLink(link)
    await createWindow()
  })
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
}