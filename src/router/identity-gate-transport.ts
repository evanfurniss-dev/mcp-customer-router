import type { Transport } from '@modelcontextprotocol/client'

type Incoming = Parameters<NonNullable<Transport['onmessage']>>

/** Keep the client handshake responsive while organization verification is in progress. */
export class IdentityGateTransport implements Transport {
  onmessage?: Transport['onmessage']
  onerror?: Transport['onerror']
  onclose?: Transport['onclose']
  private pending: Incoming[] = []
  private pendingBytes = 0
  private ready = false
  private closed = false
  private failure?: Error

  constructor(private readonly inner: Transport) {}

  async start(): Promise<void> {
    this.inner.onmessage = (...args) => {
      const [message] = args
      if (this.closed) return
      if ('method' in message && message.method === 'server/discover') {
        // mcpProxy bridges initialize-based clients. Reject their optional modern probe promptly,
        // even before identity is known, so it cannot expire and return as an unknown request ID.
        if ('id' in message) {
          void this.inner
            .send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Use initialize for this connection.' } })
            .catch((error: Error) => this.fail(error))
        }
        return
      }
      if (this.ready) {
        this.onmessage?.(...args)
        return
      }
      if ('method' in message && message.method === 'notifications/cancelled') {
        const cancelledId = message.params?.requestId
        const index = this.pending.findIndex(([queued]) => 'id' in queued && queued.id === cancelledId)
        if (index !== -1) {
          const [cancelled] = this.pending.splice(index, 1)
          this.pendingBytes -= Buffer.byteLength(JSON.stringify(cancelled[0]))
          return
        }
      }
      this.pendingBytes += Buffer.byteLength(JSON.stringify(message))
      if (this.pending.length >= 32 || this.pendingBytes > 262_144) {
        this.fail(new Error('Too many requests before organization verification.'))
        return
      }
      this.pending.push(args)
    }
    this.inner.onerror = (error) => this.fail(error)
    this.inner.onclose = () => {
      this.closed = true
      this.pending = []
      this.pendingBytes = 0
      this.onclose?.()
    }
    await this.inner.start()
  }

  /** Call only after identity verification and remote transport startup. */
  release(): void {
    if (this.failure) throw this.failure
    if (this.closed) throw new Error('The client disconnected before organization verification.')
    if (this.ready) return
    if (!this.onmessage) throw new Error('The verified connection is not ready.')
    this.ready = true
    const pending = this.pending
    this.pending = []
    this.pendingBytes = 0
    for (const args of pending) {
      if (this.closed) break
      this.onmessage(...args)
    }
  }

  send(...args: Parameters<Transport['send']>): ReturnType<Transport['send']> {
    return this.inner.send(...args)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.pending = []
    this.pendingBytes = 0
    await this.inner.close()
  }

  private fail(cause: Error): void {
    if (this.closed) return
    this.failure = cause
    void this.close().catch(() => {})
    this.onerror?.(cause)
  }
}
