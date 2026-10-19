import { describe, expect, it, vi } from 'vitest'
import type { Transport } from '@modelcontextprotocol/client'
import { IdentityGateTransport } from './identity-gate-transport'

async function fixture() {
  const inner: Transport = {
    start: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    close: vi.fn(async () => inner.onclose?.()),
  }
  const gate = new IdentityGateTransport(inner)
  const received = vi.fn()
  const errors = vi.fn()
  gate.onmessage = received
  gate.onerror = errors
  await gate.start()
  return { inner, gate, received, errors }
}

describe('identity gate transport', () => {
  it('answers discovery immediately and never forwards it, including after verification', async () => {
    const { inner, gate, received } = await fixture()
    const discovery = { jsonrpc: '2.0' as const, id: 'server-discover-probe-1', method: 'server/discover' }
    inner.onmessage?.(discovery)
    expect(inner.send).toHaveBeenCalledExactlyOnceWith({
      jsonrpc: '2.0',
      id: discovery.id,
      error: { code: -32601, message: 'Use initialize for this connection.' },
    })
    expect(received).not.toHaveBeenCalled()
    gate.release()
    inner.onmessage?.({ ...discovery, id: 'later-probe' })
    expect(inner.send).toHaveBeenCalledTimes(2)
    expect(received).not.toHaveBeenCalled()
    expect(inner.start).toHaveBeenCalledTimes(1)
  })

  it('holds requests and preserves order and transport metadata when released', async () => {
    const { inner, gate, received } = await fixture()
    const initialize = { jsonrpc: '2.0' as const, id: 1, method: 'initialize' }
    const initialized = { jsonrpc: '2.0' as const, method: 'notifications/initialized' }
    const list = { jsonrpc: '2.0' as const, id: 2, method: 'tools/list' }
    const extra = {}
    inner.onmessage?.(initialize, extra)
    inner.onmessage?.(initialized)
    inner.onmessage?.(list)
    expect(received).not.toHaveBeenCalled()
    gate.release()
    expect(received.mock.calls).toEqual([[initialize, extra], [initialized], [list]])
    gate.release()
    expect(received).toHaveBeenCalledTimes(3)
    inner.onmessage?.({ ...list, id: 3 })
    expect(received).toHaveBeenCalledTimes(4)
  })

  it('removes a cancelled queued tool call before release', async () => {
    const { inner, gate, received } = await fixture()
    inner.onmessage?.({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'write_once', arguments: {} } })
    inner.onmessage?.({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 4 } })
    const list = { jsonrpc: '2.0' as const, id: 5, method: 'tools/list' }
    inner.onmessage?.(list)
    gate.release()
    expect(received).toHaveBeenCalledExactlyOnceWith(list)
  })

  it.each(['close', 'eof', 'error'] as const)('cannot release requests after %s during verification', async (reason) => {
    const { inner, gate, received } = await fixture()
    inner.onmessage?.({ jsonrpc: '2.0', id: 1, method: 'initialize' })
    if (reason === 'close') await gate.close()
    if (reason === 'eof') inner.onclose?.()
    if (reason === 'error') inner.onerror?.(new Error('broken input'))
    expect(() => gate.release()).toThrow(reason === 'error' ? 'broken input' : 'disconnected')
    inner.onmessage?.({ jsonrpc: '2.0', id: 2, method: 'tools/call' })
    expect(received).not.toHaveBeenCalled()
    await gate.close()
    expect(inner.close).toHaveBeenCalledTimes(reason === 'eof' ? 0 : 1)
  })

  it.each(['count', 'bytes'] as const)('closes permanently when queued %s exceed the bound', async (bound) => {
    const { inner, gate, received, errors } = await fixture()
    for (let i = 0; i < (bound === 'count' ? 33 : 1); i++) {
      inner.onmessage?.({
        jsonrpc: '2.0',
        id: i,
        method: 'tools/call',
        params: { value: bound === 'bytes' ? 'x'.repeat(262_144) : '' },
      })
    }
    expect(errors).toHaveBeenCalledTimes(1)
    expect(() => gate.release()).toThrow('Too many requests')
    expect(received).not.toHaveBeenCalled()
    expect(inner.close).toHaveBeenCalledTimes(1)
  })
})
