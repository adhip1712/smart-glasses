import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.visionarynexus.app',
  appName: 'Visionary Nexus',
  webDir: 'dist',
  bundledWebRuntime: false,
  android: {
    allowMixedContent: true,
  },
  ios: {
    contentInset: 'automatic',
  },
}

export default config
