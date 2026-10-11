import { useCallback, useEffect, useRef, useState } from "react"
import { getReadAloud } from "./api"

export type ReadAloudState = "idle" | "loading" | "speaking" | "paused"
export function useReadAloud(token?: string) {
  const [state, setState] = useState<ReadAloudState>("idle")
  const [error, setError] = useState<string>()
  const playback = useRef<HTMLAudioElement | undefined>(undefined)
  const controller = useRef<AbortController | undefined>(undefined)
  const generation = useRef(0)
  const stop = useCallback(() => {
    generation.current++; controller.current?.abort(); playback.current?.pause(); playback.current = undefined; setState("idle")
  }, [])
  const speak = useCallback((text: string, lang = "en-US") => {
    stop(); setError(undefined)
    if (!token) { setError("Open a patient plan before reading it aloud"); return }
    const version = generation.current
    const abort = new AbortController(); controller.current = abort; setState("loading")
    void (async () => {
      // Bound requests to the provider's input size; never truncate a long section.
      const chunks: string[] = []
      let remaining = text.trim()
      while (remaining.length) {
        const cut = remaining.length > 4500 ? remaining.lastIndexOf(" ", 4500) : remaining.length
        if (cut <= 0) throw new Error("Read-aloud section cannot be split safely")
        chunks.push(remaining.slice(0, cut)); remaining = remaining.slice(cut).trimStart()
      }
      for (const chunk of chunks) {
        const blob = await getReadAloud(token, chunk, lang.split("-")[0], abort.signal)
        if (generation.current !== version) return
        const url = URL.createObjectURL(blob); const audio = new Audio(url); playback.current = audio
        try {
          await new Promise<void>((resolve, reject) => {
            const cancelled = () => reject(new DOMException("Cancelled", "AbortError"))
            abort.signal.addEventListener("abort", cancelled, { once: true })
            audio.onended = () => { abort.signal.removeEventListener("abort", cancelled); resolve() }
            audio.onerror = () => { abort.signal.removeEventListener("abort", cancelled); reject(new Error("Could not play generated audio")) }
            setState("speaking"); void audio.play().catch(reject)
          })
        } finally { audio.pause(); URL.revokeObjectURL(url) }
      }
    })().catch(err => { if (!abort.signal.aborted) setError(err instanceof Error ? err.message : "Read-aloud failed") })
      .finally(() => { if (generation.current === version) { playback.current = undefined; setState("idle") } })
  }, [token, stop])
  useEffect(() => stop, [stop, token])
  return { speak, stop, state, error }
}
