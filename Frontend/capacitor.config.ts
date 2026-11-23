import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.visionarynexus.app',
  appName: 'Visionary Nexus',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
  },
}

export default config
