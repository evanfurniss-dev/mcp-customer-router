export interface ConnectionCheck {
  state: 'verified' | 'error' | 'mismatch' | 'unverified'
  checkedAt: string
  observedOrgId?: string
  message: string
}

export interface Customer {
  id: string
  name: string
  business: string
  serverUrl: string
  expectedOrgId: string
  callbackPort: number
  createdAt: string
  updatedAt: string
  lastCheck?: ConnectionCheck
}

interface ProjectBinding {
  path: string
  customerId: string
  createdAt: string
}

export interface Registry {
  version: 1
  customers: Customer[]
  bindings: ProjectBinding[]
}

export interface ConnectionJob {
  id: string
  customerId: string
  state: 'running' | 'complete' | 'failed'
  message: string
  startedAt: string
  finishedAt?: string
}

export class UserError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message)
    this.name = 'UserError'
  }
}
