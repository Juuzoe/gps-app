import type { Cache } from '../engine/overpass'

/** IndexedDB-backed cache for Overpass/geocode responses (statewide road
 *  networks are megabytes — localStorage is too small, memory dies on reload). */
export class IdbCache implements Cache {
  private db?: IDBDatabase
  private ready: Promise<void>

  constructor() {
    this.ready = new Promise((resolve) => {
      try {
        const req = indexedDB.open('roadbook-cache', 1)
        req.onupgradeneeded = () => req.result.createObjectStore('kv')
        req.onsuccess = () => {
          this.db = req.result
          resolve()
        }
        req.onerror = () => resolve() // private mode etc. — run uncached
      } catch {
        resolve()
      }
    })
  }

  async get(key: string): Promise<string | undefined> {
    await this.ready
    const db = this.db
    if (!db) return undefined
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('kv', 'readonly').objectStore('kv').get(key)
        tx.onsuccess = () => resolve(typeof tx.result === 'string' ? tx.result : undefined)
        tx.onerror = () => resolve(undefined)
      } catch {
        resolve(undefined)
      }
    })
  }

  async set(key: string, value: string): Promise<void> {
    await this.ready
    const db = this.db
    if (!db) return
    return new Promise((resolve) => {
      try {
        const tx = db.transaction('kv', 'readwrite').objectStore('kv').put(value, key)
        tx.onsuccess = () => resolve()
        tx.onerror = () => resolve()
      } catch {
        resolve()
      }
    })
  }
}
