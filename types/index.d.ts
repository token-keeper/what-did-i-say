export type WhatDidISay = { text: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    'what-did-i-say': { last: WhatDidISay | null }
  }
}
