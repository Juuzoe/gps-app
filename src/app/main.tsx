import { createRoot } from 'react-dom/client'
import App from './App'
import { setCache } from '../engine/overpass'
import { IdbCache } from './idbcache'
import './styles.css'

setCache(new IdbCache())
createRoot(document.getElementById('root')!).render(<App />)
