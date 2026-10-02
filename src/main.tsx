import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'
import { installAppTimeZone } from './lib/tz'
import { syncServerClock } from './lib/serverClock'

// Algiers time everywhere, on the server's clock (whatever the device is set to).
installAppTimeZone()
syncServerClock()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
