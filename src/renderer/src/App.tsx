import { useState } from 'react'

function App() {
  const [pong, setPong] = useState('')
  const [error, setError] = useState('')

  async function handlePing(): Promise<void> {
    setError('')
    try {
      const result = await window.api.ping()
      setPong(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-neutral-900 text-neutral-100">
      <h1 className="text-3xl font-semibold tracking-tight">Unwater</h1>
      <p className="text-neutral-400">Local AI watermark remover — Phase 0 scaffold</p>

      <button
        onClick={handlePing}
        className="rounded-lg bg-indigo-600 px-5 py-2.5 font-medium transition-colors hover:bg-indigo-500 active:bg-indigo-700"
      >
        Ping main process
      </button>

      {pong && (
        <p className="text-emerald-400">
          Round-trip OK — main replied: <span className="font-mono">{pong}</span>
        </p>
      )}
      {error && <p className="text-red-400">Error: {error}</p>}
    </div>
  )
}

export default App
