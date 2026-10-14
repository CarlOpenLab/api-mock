import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './panel.css'

const container = document.getElementById('root')
if (!container) throw new Error('panel.html 缺少 #root')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
