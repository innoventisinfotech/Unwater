/**
 * Minimal single-active-job queue. v1 processes one heavy job at a time; this tracks the
 * current job's id and a cooperative cancellation flag that engines poll between tiles/frames.
 */
export class JobQueue {
  private current: { id: string; cancelled: boolean } | null = null

  /** Begin a job. Throws if another job is already active. */
  begin(id: string): void {
    if (this.current) throw new Error('A job is already running. Cancel it before starting another.')
    this.current = { id, cancelled: false }
  }

  /** Request cancellation of the given job (no-op if it is not the active one). */
  cancel(id: string): void {
    if (this.current?.id === id) this.current.cancelled = true
  }

  /** Whether the given job has been asked to cancel. */
  isCancelled(id: string): boolean {
    return this.current?.id === id ? this.current.cancelled : false
  }

  /** Mark the job finished (success, error, or cancel). */
  end(id: string): void {
    if (this.current?.id === id) this.current = null
  }

  get activeId(): string | null {
    return this.current?.id ?? null
  }
}
