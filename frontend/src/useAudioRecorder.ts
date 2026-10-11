import { useCallback, useEffect, useRef, useState } from "react"

// Record locally; only the backend accesses AWS Transcribe Medical.
export function useAudioRecorder() {
  const [isRecording, setIsRecording] = useState(false)
  const [audio, setAudio] = useState<Blob>()
  const [error, setError] = useState<string>()
  const recorder = useRef<MediaRecorder | undefined>(undefined)
  const stream = useRef<MediaStream | undefined>(undefined)
  const generation = useRef(0)
  const release = () => { stream.current?.getTracks().forEach(t => t.stop()); stream.current = undefined }
  const stop = useCallback(() => {
    if (recorder.current?.state === "recording") recorder.current.stop()
    setIsRecording(false)
  }, [])
  const clear = useCallback(() => {
    generation.current++
    stop(); release(); setAudio(undefined); setError(undefined)
  }, [stop])
  const start = useCallback(async () => {
    clear()
    const version = generation.current
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("Audio recording requires a supported browser over HTTPS or localhost.")
      const input = await navigator.mediaDevices.getUserMedia({ audio: true })
      if (version !== generation.current) { input.getTracks().forEach(t => t.stop()); return }
      stream.current = input
      const mimeType = ["audio/webm", "audio/ogg", "audio/mp4"].find(t => MediaRecorder.isTypeSupported(t))
      const next = new MediaRecorder(input, mimeType ? { mimeType } : undefined)
      const chunks: Blob[] = []
      next.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
      next.onstop = () => {
        if (version === generation.current) {
          setAudio(new Blob(chunks, { type: next.mimeType })); setIsRecording(false); release()
        }
      }
      next.onerror = () => { setError("Recording failed. Try again."); stop(); release() }
      recorder.current = next
      next.start(); setIsRecording(true)
    } catch (err) { release(); setError(err instanceof Error ? err.message : "Microphone unavailable.") }
  }, [clear, stop])
  useEffect(() => () => { generation.current++; stop(); release() }, [stop])
  return { isRecording, audio, error, start, stop, clear }
}
