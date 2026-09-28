import { useCallback, useEffect, useState } from 'react'

/** Loads data for a page, with a reload function and the last error. */
export function useLoad<T>(load: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null)
  const [error, setError] = useState<string | null>(null)
  const reload = useCallback(async () => {
    try {
      setError(null)
      setData(await load())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [load])
  useEffect(() => {
    reload()
  }, [reload])
  return { data, error, setError, reload }
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Date and time formatting in the app's language. */
export const locale = (lang: 'fr' | 'ar') => (lang === 'ar' ? 'ar-DZ' : 'fr-FR')
