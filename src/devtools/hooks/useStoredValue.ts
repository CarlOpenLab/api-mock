import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 把 chrome.storage.local 的一个键读成 React state。
 *
 * 面板写、background 靠 onChanged 感知并广播给页面，所以两个方向都走
 * storage 就够了——不需要再为规则单独开一条消息通道。
 */
export function useStoredValue<T>(
  key: string,
  fallback: T,
): [T, (next: T) => void, boolean] {
  const [value, setValue] = useState<T>(fallback)
  const [loaded, setLoaded] = useState(false)

  // fallback 常常是字面量，每次渲染都是新引用，不能进依赖数组。
  const fallbackRef = useRef(fallback)
  fallbackRef.current = fallback

  useEffect(() => {
    let alive = true

    void chrome.storage.local.get(key).then((stored) => {
      if (!alive) return
      const raw = stored[key]
      if (raw !== undefined) setValue(raw as T)
      setLoaded(true)
    })

    const onChange = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ) => {
      if (area !== 'local' || !(key in changes)) return
      const next = changes[key].newValue
      setValue(next === undefined ? fallbackRef.current : (next as T))
    }

    chrome.storage.onChanged.addListener(onChange)
    return () => {
      alive = false
      chrome.storage.onChanged.removeListener(onChange)
    }
  }, [key])

  const write = useCallback(
    (next: T) => {
      // 乐观更新：面板自己写的值没必要等 storage 的往返。
      setValue(next)
      void chrome.storage.local.set({ [key]: next })
    },
    [key],
  )

  return [value, write, loaded]
}
