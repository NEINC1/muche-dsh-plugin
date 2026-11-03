import React from 'react'
import { createRoot } from 'react-dom/client'
import { clientDefinition } from './entry.js'

const client = clientDefinition.factory(name => {
  if (name !== 'react') throw new Error(`Unexpected desktop chat dependency: ${name}`)
  return React
})
client.desktopView.start()
const root = createRoot(document.getElementById('muche-desktop-chat-root'))
root.render(React.createElement(client.desktopView.ChatPanel))
window.addEventListener('beforeunload', () => { root.unmount(); client.desktopView.dispose() }, { once: true })
