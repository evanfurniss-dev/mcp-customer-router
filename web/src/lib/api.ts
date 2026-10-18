export interface Customer {
  id: string
  name: string
  business: string
  serverUrl: string
  expectedOrgId: string
  callbackPort: number
  createdAt: string
  updatedAt: string
  lastCheck?: { state: 'verified' | 'error' | 'mismatch' | 'unverified'; checkedAt: string; observedOrgId?: string; message: string }
}
export interface Job { id: string; customerId: string; state: 'running' | 'complete' | 'failed'; message: string; startedAt: string; finishedAt?: string }
export interface RouterState { customers: Customer[]; bindings: { path: string; customerId: string; createdAt: string }[]; jobs: Job[] }
export interface Plan { planId: string; projectPath: string; files: { path: string; content: string; changed: boolean }[]; warnings: string[] }
let session: Promise<string> | undefined
async function getToken() {
  if (!session) session = fetch('/api/session', { cache: 'no-store', credentials: 'same-origin' }).then(async (res) => {
    if (!res.ok) throw new Error('Cannot open the local session. Check that the router is running, then reload this page.')
    const body = await res.json()
    if (typeof body.token !== 'string') throw new Error('The local session response was incomplete. Reload this page.')
    return body.token as string
  }).catch((error) => { session = undefined; throw error })
  return session
}
export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getToken()
  const res = await fetch(path, { ...init, cache: 'no-store', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'x-router-token': token, ...init?.headers } })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) session = undefined
    throw new Error(body?.error || `The local router could not finish this request (${res.status}). Try again.`)
  }
  return body as T
}
export const post = <T,>(path: string, data?: unknown) => api<T>(path, { method: 'POST', body: data === undefined ? undefined : JSON.stringify(data) })
export function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'The request failed. Try again.' }
