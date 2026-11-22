const { contextBridge } = require('electron')

contextBridge.exposeInMainWorld('visionaryNexusDesktop', Object.freeze({
  isDesktop: true,
  platform: process.platform
}))
