import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowLeft, Check, CircleAlert, ListFilter, Moon, Plus, RefreshCw, Search, Sun, X } from 'lucide-react'
import { Menu } from '@base-ui/react/menu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { api, errorMessage, post, type Customer, type Job, type Plan, type RouterState, type ConnectionAction } from '@/lib/api'
import { useTheme } from '@/lib/theme'
import { RouterWalkthrough, shouldShowWalkthrough } from '@/components/router-walkthrough'
import { ClientSetup, useClientChoice } from '@/components/client-setup'
import { ConnectionReview } from '@/components/connection-review'

const EMPTY: RouterState = { customers: [], bindings: [], jobs: [] }
function readRoute() { try { return decodeURIComponent(window.location.hash.slice(1)) } catch { return '' } }
function dateLabel(value?: string) {
  if (!value) return 'Never checked'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Check time unavailable' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'error' | 'warning' | 'success' }) {
  return <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : undefined}>
    {children}
  </div>
}
function Status({ customer, running = false, compact = false }: { customer: Customer; running?: boolean; compact?: boolean }) {
  const state = customer.lastCheck?.state
  const failed = !running && (state === 'mismatch' || state === 'error')
  const label = running ? 'Checking connection' : state === 'verified' ? 'Organization verified' : state === 'mismatch' ? 'Wrong organization' : state === 'error' ? 'Check failed' : 'Not connected'
  return <span className={`connection-status ${failed ? 'status-error' : ''} ${compact ? 'status-compact' : ''}`} title={compact ? label : undefined}>
    {running ? <RefreshCw className="busy-icon" aria-hidden="true" /> : state === 'verified' ? <Check aria-hidden="true" /> : failed ? <CircleAlert aria-hidden="true" /> : <span className="status-dot" aria-hidden="true" />}
    <span className={compact && (state === 'verified' || running) ? 'sr-only' : ''}>{label}</span>
  </span>
}

function BusinessFilter({ businesses, value, onChange }: { businesses: string[]; value: string; onChange: (value: string) => void }) {
  return <Menu.Root>
    <Menu.Trigger render={<Button variant="ghost" className={`icon-button filter-trigger ${value ? 'is-filtered' : ''}`} />} aria-label={`Business filter: ${value || 'All businesses'}`} title={value || 'Filter by business'}>
      <ListFilter aria-hidden="true" />{value && <span className="filter-dot" aria-hidden="true" />}
    </Menu.Trigger>
    <Menu.Portal><Menu.Positioner sideOffset={8} align="end" collisionPadding={12} className="menu-positioner">
      <Menu.Popup className="filter-menu" aria-label="Filter by business">
        <Menu.Group><Menu.GroupLabel className="menu-label">Business</Menu.GroupLabel>
          <Menu.RadioGroup value={value} onValueChange={onChange}>
            {['', ...businesses].map(item => <Menu.RadioItem className="menu-option" value={item} key={item} closeOnClick>
              <span>{item || 'All businesses'}</span><Menu.RadioItemIndicator><Check aria-hidden="true" /></Menu.RadioItemIndicator>
            </Menu.RadioItem>)}
          </Menu.RadioGroup>
        </Menu.Group>
      </Menu.Popup>
    </Menu.Positioner></Menu.Portal>
  </Menu.Root>
}
function Field({ label, id, hint, children }: { label: string; id: string; hint?: ReactNode; children: ReactNode }) {
  return <div className="form-field"><label htmlFor={id}>{label}</label>{children}{hint && <p id={`${id}-hint`} className="field-hint">{hint}</p>}</div>
}

export default function App() {
  const { theme, setTheme } = useTheme()
  const [data, setData] = useState<RouterState>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [route, setRoute] = useState(readRoute)
  const [query, setQuery] = useState('')
  const [business, setBusiness] = useState('')
  const [creating, setCreating] = useState(false)
  const [walkthroughOpen, setWalkthroughOpen] = useState(shouldShowWalkthrough)
  const [client, chooseClient] = useClientChoice()
  const [pendingJob, setPendingJob] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const sequence = useRef(0)
  const detailHeading = useRef<HTMLHeadingElement>(null)
  const newCustomerTrigger = useRef<HTMLElement | null>(null)
  const load = useCallback(async (manual = false) => {
    const seq = ++sequence.current
    if (manual) setLoading(true)
    try {
      const next = await api<RouterState>('/api/state')
      if (seq === sequence.current) { setData(next); setError(''); setLoaded(true) }
      return next
    } catch (e) { if (seq === sequence.current) setError(errorMessage(e)); return null }
    finally { if (seq === sequence.current) setLoading(false) }
  }, [])
  useEffect(() => { void load(true); return () => { sequence.current++ } }, [load])
  useEffect(() => { const handler = () => setRoute(readRoute()); window.addEventListener('hashchange', handler); return () => window.removeEventListener('hashchange', handler) }, [])
  const activeJobs = data.jobs.some(job => job.state === 'running')
  useEffect(() => {
    if (!activeJobs && !pendingJob) return
    const timer = window.setInterval(() => { void load() }, 1500)
    return () => window.clearInterval(timer)
  }, [activeJobs, pendingJob, load])
  useEffect(() => {
    if (!pendingJob) return
    const job = data.jobs.find(item => item.id === pendingJob)
    if (job && job.state !== 'running') { setAnnouncement(job.message); setPendingJob(null) }
  }, [data.jobs, pendingJob])
  useEffect(() => { if (route && loaded && !walkthroughOpen) detailHeading.current?.focus() }, [route, loaded, walkthroughOpen])
  const customer = data.customers.find(item => item.id === route)
  const businesses = useMemo(() => [...new Set(data.customers.map(item => item.business))].sort(), [data.customers])
  const filtered = data.customers.filter(item => (!business || item.business === business) && `${item.name} ${item.business} ${item.expectedOrgId}`.toLowerCase().includes(query.trim().toLowerCase()))
  async function jobStarted(id: string) { setPendingJob(id); await load() }
  function created(item: Customer) { setQuery(''); setBusiness(''); setData(old => ({ ...old, customers: [...old.customers, item] })); window.location.hash = encodeURIComponent(item.id); setAnnouncement(`${item.name} saved. Connect Glide to verify the organization.`); void load() }

  return <>
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus() }}>Skip to customer details</a>
    <div className="app-shell">
      <header className="app-header">
        <a href="#" className="app-title" aria-label="Glide MCP router">
          <img src="/glide-mark.svg" width="26" height="26" alt="" />
          <span className="brand-name">Glide</span><span className="app-name">MCP router</span>
        </a>
        <div className="header-actions">
          <ClientSetup client={client} onClientChange={chooseClient} />
          <Button variant="ghost" className="icon-button" onClick={() => void load(true)} loading={loading} aria-label="Refresh" title="Refresh"><RefreshCw aria-hidden="true" /></Button>
          <Button variant="ghost" className="icon-button" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`} title={`Switch to ${theme === 'dark' ? 'light' : 'dark'} mode`}>{theme === 'dark' ? <Sun aria-hidden="true" /> : <Moon aria-hidden="true" />}</Button>
          <RouterWalkthrough open={walkthroughOpen} onOpenChange={setWalkthroughOpen} client={client} onClientChange={chooseClient} />
        </div>
      </header>
      <div className={`workspace-layout ${route ? 'has-detail' : ''}`}>
        <aside className="customer-sidebar" aria-label="Customer directory">
          <div className="sidebar-heading"><h2>Customers <span className="count">{loaded ? data.customers.length : '…'}</span></h2><Button variant="default" className="new-customer" aria-label="New customer" onClick={event => { newCustomerTrigger.current = event.currentTarget; setCreating(true) }} disabled={!loaded || !!error}><Plus aria-hidden="true" />New</Button></div>
          <div className="directory-controls">
            <div className="directory-search"><Search aria-hidden="true" /><Input unstyled id="customer-search" aria-label="Search" type="search" placeholder="Search customers" value={query} onChange={event => setQuery(event.target.value)} />{query && <Button variant="ghost" className="icon-button clear-search" aria-label="Clear search" onClick={() => { setQuery(''); document.getElementById('customer-search')?.focus() }}><X aria-hidden="true" /></Button>}</div>
            <BusinessFilter businesses={businesses} value={business} onChange={setBusiness} />
          </div>
          {business && <div className="active-filter"><span>{business}</span><Button variant="ghost" className="icon-button" aria-label="Clear business filter" onClick={() => { setBusiness(''); document.getElementById('customer-search')?.focus() }}><X aria-hidden="true" /></Button></div>}
          <nav aria-label="Customers" className="customer-list">
            {filtered.map(item => <a href={`#${encodeURIComponent(item.id)}`} className={`customer-row ${route === item.id ? 'is-selected' : ''}`} aria-current={route === item.id ? 'page' : undefined} key={item.id}>
              <span className="customer-row-content"><span className="customer-name">{item.name}</span>{item.business !== item.name && <span className="customer-business">{item.business}</span>}</span><Status compact customer={item} running={data.jobs.some(job => job.customerId === item.id && job.state === 'running')} />
            </a>)}
            {loaded && filtered.length === 0 && <div className="directory-empty"><p>{data.customers.length ? 'No matching customers.' : 'No customers saved.'}</p>{(query || business) && <Button variant="ghost" onClick={() => { setQuery(''); setBusiness('') }}>Clear filters</Button>}</div>}
          </nav>
        </aside>
        <main id="main-content" className="main-content" tabIndex={-1}>
          {error && <Notice tone="error"><strong>Router unavailable</strong><p>{error}</p><Button variant="outline" onClick={() => void load(true)}>Try again</Button></Notice>}
          {!loaded && !error ? <div className="page-loading" role="status"><RefreshCw className="busy-icon" aria-hidden="true" />Loading customer connections…</div> : customer ? <CustomerDetail key={customer.id} customer={customer} bindings={data.bindings.filter(item => item.customerId === customer.id)} jobs={data.jobs.filter(item => item.customerId === customer.id)} headingRef={detailHeading} unavailable={!!error} refresh={load} jobStarted={jobStarted} announce={setAnnouncement} /> : route && loaded ? <div className="empty-page"><h1>Customer not found</h1><p>This entry may have been removed.</p><a href="#" className="text-link">Return to customers</a></div> : <div className="overview">
            <h1>{data.customers.length ? 'Select a customer' : 'Add a customer'}</h1><p>{data.customers.length ? 'View its connection and project bindings.' : 'Use the customer’s Glide organization ID.'}</p>
          </div>}
        </main>
      </div>
    </div>
    <div className="sr-only" role="status" aria-live="polite">{announcement}</div>
    <NewCustomer open={creating} onOpenChange={setCreating} businesses={businesses} onCreated={created} returnFocus={newCustomerTrigger} successFocus={detailHeading} />
  </>
}

function NewCustomer({ open, onOpenChange, businesses, onCreated, returnFocus, successFocus }: { open: boolean; onOpenChange: (open: boolean) => void; businesses: string[]; onCreated: (customer: Customer) => void; returnFocus: React.RefObject<HTMLElement | null>; successFocus: React.RefObject<HTMLHeadingElement | null> }) {
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const saved = useRef(false)
  useEffect(() => { if (open) { setError(''); saved.current = false } }, [open])
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const fields = new FormData(event.currentTarget)
    setSaving(true); setError('')
    try {
      const customer = await post<Customer>('/api/customers', Object.fromEntries(['name', 'business', 'expectedOrgId', 'serverUrl'].map(key => [key, String(fields.get(key) || '').trim()])))
      saved.current = true; onCreated(customer); onOpenChange(false)
    } catch (e) { setError(errorMessage(e)) } finally { setSaving(false) }
  }
  return <Dialog open={open} onOpenChange={next => { if (!saving) onOpenChange(next) }}>
    <DialogPopup showCloseButton={false} bottomStickOnMobile={false} className="customer-dialog" finalFocus={() => saved.current ? successFocus.current : returnFocus.current}>
      <DialogHeader><DialogTitle>Add customer</DialogTitle><DialogDescription className="sr-only">Save a Glide organization for project connections.</DialogDescription></DialogHeader>
      <form className="dialog-form" onSubmit={submit}>
        <DialogPanel className="grid gap-4">
          {error && <Notice tone="error">{error}</Notice>}
          <Field id="new-name" label="Customer name"><Input id="new-name" name="name" required maxLength={100} autoComplete="off" autoFocus /></Field>
          <Field id="new-business" label="Business"><Input id="new-business" name="business" required maxLength={100} autoComplete="off" list="business-options" placeholder="Your agency" /><datalist id="business-options">{businesses.map(value => <option value={value} key={value} />)}</datalist></Field>
          <Field id="new-org" label="Expected organization ID" hint="From the Glide organization URL."><Input id="new-org" name="expectedOrgId" required autoComplete="off" spellCheck={false} aria-describedby="new-org-hint" /></Field>
          <details className="advanced-settings"><summary>MCP endpoint</summary><Field id="new-server" label="MCP server URL"><Input id="new-server" name="serverUrl" type="url" required defaultValue="https://mcp.glideapps.dev/mcp" autoComplete="off" spellCheck={false} /></Field></details>
        </DialogPanel>
        <DialogFooter><DialogClose render={<Button variant="ghost" disabled={saving} />}>Cancel</DialogClose><Button type="submit" loading={saving}>Save customer</Button></DialogFooter>
      </form>
    </DialogPopup>
  </Dialog>
}

function CustomerDetail({ customer, bindings, jobs, headingRef, unavailable, refresh, jobStarted, announce }: {
  customer: Customer; bindings: RouterState['bindings']; jobs: Job[]; headingRef: React.RefObject<HTMLHeadingElement | null>; unavailable: boolean
  refresh: () => Promise<RouterState | null>; jobStarted: (id: string) => Promise<void>; announce: (message: string) => void
}) {
  const [starting, setStarting] = useState<'connect' | 'check' | null>(null)
  const [error, setError] = useState('')
  const [removing, setRemoving] = useState(false)
  const [removeOpen, setRemoveOpen] = useState(false)
  const latestJob = [...jobs].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
  const runningJob = jobs.find(job => job.state === 'running')
  const running = !!runningJob || starting !== null
  const verified = customer.lastCheck?.state === 'verified'
  async function run(action: 'connect' | 'check') {
    setStarting(action); setError('')
    try { const result = await post<{ jobId: string }>(`/api/customers/${encodeURIComponent(customer.id)}/${action}`); await jobStarted(result.jobId) }
    catch (e) { setError(errorMessage(e)) } finally { setStarting(null) }
  }
  async function remove() {
    setRemoving(true); setError('')
    try { await api(`/api/customers/${encodeURIComponent(customer.id)}`, { method: 'DELETE' }); setRemoveOpen(false); window.location.hash = ''; await refresh(); announce(`${customer.name} removed from saved customers.`) }
    catch (e) { setError(errorMessage(e)); setRemoveOpen(false) } finally { setRemoving(false) }
  }
  return <article className="customer-detail">
    <a href="#" className="back-link"><ArrowLeft aria-hidden="true" />All customers</a>
    <header className="detail-header"><h1 ref={headingRef} tabIndex={-1}>{customer.name}</h1><div className="detail-meta">{customer.business !== customer.name && <span>{customer.business}</span>}<Status customer={customer} running={running} /></div></header>
    <section className="connection-section" aria-label="Connection">
      <div className="connection-heading"><h2>Connection</h2><div className="connection-actions"><Button variant="outline" onClick={() => void run('connect')} loading={starting === 'connect'} disabled={running || unavailable}>{verified ? 'Reconnect Glide' : 'Connect Glide'}</Button><Button variant="outline" onClick={() => void run('check')} loading={starting === 'check'} disabled={running || unavailable}>Check identity</Button></div></div>
      <dl className="identity-grid"><div><dt>Organization ID</dt><dd className="mono">{customer.expectedOrgId}</dd></div>{customer.lastCheck?.observedOrgId && customer.lastCheck.observedOrgId !== customer.expectedOrgId && <div><dt>Observed org</dt><dd className="mono">{customer.lastCheck.observedOrgId}</dd></div>}<div className="endpoint-field"><dt>MCP endpoint</dt><dd className="mono">{customer.serverUrl}</dd></div><div><dt>Last check</dt><dd>{dateLabel(customer.lastCheck?.checkedAt)}</dd></div></dl>
      {customer.lastCheck?.message && customer.lastCheck.state !== 'verified' && <Notice tone={customer.lastCheck.state === 'unverified' ? 'info' : 'error'}>{customer.lastCheck.message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {starting === 'connect' && !runningJob && <Notice>Preparing Glide sign-in…</Notice>}
      {!unavailable && runningJob?.authorizationUrl && <Notice><p>Select this customer’s organization in Glide.</p><Button variant="outline" render={<a href={runningJob.authorizationUrl} target="_blank" rel="noopener noreferrer" />}>Open Glide sign-in</Button></Notice>}
      {latestJob && latestJob.state !== 'complete' && !(latestJob.state === 'running' && runningJob?.authorizationUrl && !unavailable) && latestJob.message !== customer.lastCheck?.message && <div className={`job-status ${latestJob.state === 'failed' ? 'job-failed' : ''}`} role="status">{latestJob.state === 'running' && <RefreshCw className="busy-icon" aria-hidden="true" />}<p>{latestJob.message}</p></div>}
    </section>
    <ProjectBinding customer={customer} bindings={bindings} unavailable={unavailable || running} refresh={refresh} announce={announce} />
    <details className="usage-help"><summary>Connection details</summary><div><dl className="technical-details"><div><dt>Customer ID</dt><dd className="mono">{customer.id}</dd></div><div><dt>OAuth callback port</dt><dd className="mono">{customer.callbackPort}</dd></div>{latestJob && <div><dt>Last job</dt><dd>{latestJob.state}: {latestJob.message}</dd></div>}</dl></div></details>
    <footer className="detail-footer"><p>Saved {dateLabel(customer.createdAt)}</p><Dialog open={removeOpen} onOpenChange={next => { if (!removing) setRemoveOpen(next) }}><DialogTrigger render={<Button variant="ghost" disabled={bindings.length > 0 || running || unavailable} />}>Remove saved entry</DialogTrigger><DialogPopup showCloseButton={false} bottomStickOnMobile={false}><DialogHeader><DialogTitle>Remove {customer.name}?</DialogTitle><DialogDescription>This removes the saved customer entry. Protected local sign-in files remain available for recovery. Glide access is not revoked.</DialogDescription></DialogHeader><DialogFooter><DialogClose render={<Button variant="ghost" disabled={removing} />}>Cancel</DialogClose><Button variant="destructive" loading={removing} onClick={() => void remove()}>Remove saved entry</Button></DialogFooter></DialogPopup></Dialog></footer>
    {bindings.length > 0 && <p className="removal-note">Removal blocked by project bindings.</p>}
  </article>
}

function ProjectBinding({ customer, bindings, unavailable, refresh, announce }: { customer: Customer; bindings: RouterState['bindings']; unavailable: boolean; refresh: () => Promise<RouterState | null>; announce: (message: string) => void }) {
  const [path, setPath] = useState('')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [busy, setBusy] = useState<'choose' | 'preview' | 'apply' | null>(null)
  const [error, setError] = useState('')
  const [applied, setApplied] = useState('')
  const [backups, setBackups] = useState<{ filePath: string; backupPath: string }[]>([])
  const [acknowledged, setAcknowledged] = useState(false)
  const [connectionActions, setConnectionActions] = useState<ConnectionAction[]>([])
  const previewRef = useRef<HTMLHeadingElement>(null)
  const folderButton = useRef<HTMLButtonElement>(null)
  const verified = customer.lastCheck?.state === 'verified'
  const connections = plan?.connections ?? []
  const allConnectionsReviewed = connections.every(connection => connectionActions.some(action => action.id === connection.id))
  const removalCount = connectionActions.filter(action => action.action === 'remove').length
  useEffect(() => { if (plan) previewRef.current?.focus() }, [plan])
  async function chooseFolder() {
    setBusy('choose'); setError(''); announce('Choose a project folder in the macOS dialog.')
    try {
      const result = await post<{ projectPath: string | null }>('/api/projects/choose-folder', {})
      if (result.projectPath !== null) {
        setPath(result.projectPath); setPlan(null); setApplied(''); setAcknowledged(false); setConnectionActions([])
        announce('Folder selected. Review settings to continue.')
      } else { announce('Folder selection canceled.') }
    } catch (e) { setError(errorMessage(e)) }
    finally { setBusy(null); window.requestAnimationFrame(() => folderButton.current?.focus()) }
  }
  async function preview(event: FormEvent) {
    event.preventDefault(); setBusy('preview'); setError(''); setApplied(''); setPlan(null); setAcknowledged(false); setConnectionActions([])
    try {
      const result = await post<Plan>('/api/projects/preview', { customerId: customer.id, projectPath: path })
      setConnectionActions(result.connections.map(connection => ({ id: connection.id, action: 'ignore' })))
      setPlan(result)
    }
    catch (e) { setError(errorMessage(e)) } finally { setBusy(null) }
  }
  async function apply() {
    if (!plan || !allConnectionsReviewed || (plan.warnings.length > 0 && !acknowledged)) return
    setBusy('apply'); setError('')
    try {
      const result = await post<{ ok: true; projectPath: string; backups: { filePath: string; backupPath: string }[] }>('/api/projects/apply', { planId: plan.planId, connectionActions })
      setApplied(result.projectPath); setBackups(result.backups ?? []); setPlan(null); setConnectionActions([]); await refresh(); announce('Project settings saved. Start a new agent session to load them.')
    } catch (e) { setError(errorMessage(e)); setPlan(null) } finally { setBusy(null) }
  }
  return <section className="project-section">
    <div className="section-heading"><h2>Projects <span className="count">{bindings.length}</span></h2></div>
    {bindings.length > 0 && <ul className="bound-projects">{bindings.map(binding => <li key={binding.path}><button className="path-button mono" disabled={busy !== null} onClick={() => { setPath(binding.path); setPlan(null); setApplied(''); setError('') }}>{binding.path}</button><p>Saved {dateLabel(binding.createdAt)}</p></li>)}</ul>}
    <form className="project-form" onSubmit={preview}>
      <Field id="project-path" label={bindings.length ? 'Bind another project' : 'Project folder'}><div className="project-input-row"><Input id="project-path" name="projectPath" value={path} onChange={event => { setPath(event.target.value); setPlan(null); setError(''); setApplied('') }} required autoComplete="off" spellCheck={false} placeholder="/Users/you/Projects/customer-project" disabled={busy !== null} /><Button ref={folderButton} variant="outline" onClick={() => void chooseFolder()} loading={busy === 'choose'} disabled={busy !== null || unavailable}>Choose folder</Button><Button type="submit" variant="outline" loading={busy === 'preview'} disabled={busy !== null || unavailable}>Preview config</Button></div></Field>
    </form>
    {busy === 'choose' && <p className="field-hint" role="status">The folder picker is open on this Mac.</p>}
    {error && <Notice tone="error">{error}</Notice>}
    {applied && <Notice tone="success"><strong>Config saved</strong><p className="mono break-anywhere">{applied}</p><p>Start a new client session and verify the customer connection.</p>{backups.length > 0 && <details className="settings-backups"><summary>Settings backups</summary><p>To undo a removal, copy the removed entry from its backup into the settings file.</p><ul>{backups.map(item => <li key={item.filePath}><span className="mono break-anywhere">{item.backupPath}</span></li>)}</ul></details>}</Notice>}
    {plan && <div className="config-review"><div className="review-heading"><h3 ref={previewRef} tabIndex={-1}>Config preview</h3><p className="mono break-anywhere">{plan.projectPath}</p></div>
      {!verified && <Notice tone="warning">Verify the organization before applying config.</Notice>}
      {plan.warnings.length > 0 && <Notice tone="warning"><strong>Some settings could not be checked</strong><ul>{plan.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></Notice>}
      <ConnectionReview connections={connections} actions={connectionActions} disabled={busy !== null} onChange={action => setConnectionActions(current => [...current.filter(item => item.id !== action.id), action])} />
      <p className="preview-caption">Generated config entries.</p>
      <div className="preview-files">{plan.files.map(file => <details key={file.path} open><summary><span className="mono">{file.path}</span><Badge variant={file.changed ? 'info' : 'secondary'}>{file.changed ? 'Will change' : 'No change'}</Badge></summary><pre tabIndex={0} aria-label={`Generated settings for ${file.path}`}><code>{file.content}</code></pre></details>)}</div>
      {plan.warnings.length > 0 && <label className="warning-acknowledgment"><input type="checkbox" checked={acknowledged} disabled={busy !== null} onChange={event => setAcknowledged(event.target.checked)} /><span>Continue with the settings that could be checked.</span></label>}
      <div className="review-actions"><Button variant="ghost" disabled={busy !== null} onClick={() => { setPlan(null); setConnectionActions([]) }}>Cancel review</Button><Button onClick={() => void apply()} loading={busy === 'apply'} disabled={busy !== null || !verified || unavailable || !allConnectionsReviewed || (plan.warnings.length > 0 && !acknowledged)}>{removalCount > 0 ? `Apply and remove ${removalCount}` : 'Apply config'}</Button></div>
    </div>}
  </section>
}
