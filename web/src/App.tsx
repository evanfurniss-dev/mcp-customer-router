import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, Check, ChevronRight, CircleAlert, Folder, Link2, Plus, RefreshCw, Search, ShieldCheck, Unplug } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Card, CardPanel } from '@/components/ui/card'
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { api, errorMessage, post, type Customer, type Job, type Plan, type RouterState } from '@/lib/api'

const EMPTY: RouterState = { customers: [], bindings: [], jobs: [] }
function readRoute() { try { return decodeURIComponent(window.location.hash.slice(1)) } catch { return '' } }
function dateLabel(value?: string) {
  if (!value) return 'Never checked'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Check time unavailable' : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date)
}
function Notice({ children, tone = 'info' }: { children: ReactNode; tone?: 'info' | 'error' | 'warning' | 'success' }) {
  return <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : undefined}>
    {tone === 'success' ? <Check aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}<div>{children}</div>
  </div>
}
function Status({ customer, running = false }: { customer: Customer; running?: boolean }) {
  if (running) return <Badge variant="info"><RefreshCw aria-hidden="true" className="busy-icon" />Checking</Badge>
  const state = customer.lastCheck?.state
  return <Badge variant={state === 'verified' ? 'success' : state === 'mismatch' || state === 'error' ? 'error' : 'secondary'}>
    {state === 'verified' ? <ShieldCheck aria-hidden="true" /> : state === 'mismatch' || state === 'error' ? <CircleAlert aria-hidden="true" /> : <Unplug aria-hidden="true" />}
    {state === 'verified' ? 'Verified' : state === 'mismatch' ? 'Wrong organization' : state === 'error' ? 'Check failed' : 'Not connected'}
  </Badge>
}
function Field({ label, id, hint, children }: { label: string; id: string; hint?: ReactNode; children: ReactNode }) {
  return <div className="form-field"><label htmlFor={id}>{label}</label>{children}{hint && <p id={`${id}-hint`} className="field-hint">{hint}</p>}</div>
}

export default function App() {
  const [data, setData] = useState<RouterState>(EMPTY)
  const [loaded, setLoaded] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [route, setRoute] = useState(readRoute)
  const [query, setQuery] = useState('')
  const [business, setBusiness] = useState('')
  const [creating, setCreating] = useState(false)
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
  useEffect(() => { if (route && loaded) detailHeading.current?.focus() }, [route, loaded])
  const customer = data.customers.find(item => item.id === route)
  const businesses = useMemo(() => [...new Set(data.customers.map(item => item.business))].sort(), [data.customers])
  const filtered = data.customers.filter(item => (!business || item.business === business) && `${item.name} ${item.business} ${item.expectedOrgId}`.toLowerCase().includes(query.trim().toLowerCase()))
  const verifiedCount = data.customers.filter(item => item.lastCheck?.state === 'verified').length
  async function jobStarted(id: string) { setPendingJob(id); await load() }
  function created(item: Customer) { setQuery(''); setBusiness(''); setData(old => ({ ...old, customers: [...old.customers, item] })); window.location.hash = encodeURIComponent(item.id); setAnnouncement(`${item.name} saved. Connect Glide to verify the organization.`); void load() }

  return <>
    <a className="skip-link" href="#main-content" onClick={event => { event.preventDefault(); document.getElementById('main-content')?.focus() }}>Skip to customer details</a>
    <div className="app-shell">
      <header className="app-header">
        <a href="#" className="brand" aria-label="Customer connections home"><span className="brand-mark"><Link2 aria-hidden="true" /></span><span>Customer connections<span className="brand-caption">Local MCP router</span></span></a>
        <div className="header-actions"><span className="local-pill"><span />On this Mac</span><Button variant="outline" onClick={() => void load(true)} loading={loading}><RefreshCw aria-hidden="true" />Refresh</Button></div>
      </header>
      <div className={`workspace-layout ${route ? 'has-detail' : ''}`}>
        <aside className="customer-sidebar" aria-label="Customer directory">
          <div className="sidebar-heading"><div><h2>Customers</h2><p>{loaded ? `${data.customers.length} saved · ${verifiedCount} verified` : 'Loading connections…'}</p></div><Button variant="outline" onClick={event => { newCustomerTrigger.current = event.currentTarget; setCreating(true) }} disabled={!loaded || !!error}><Plus aria-hidden="true" />Add</Button></div>
          <div className="directory-controls">
            <label className="sr-only" htmlFor="customer-search">Search customers</label><div className="search-field"><Search aria-hidden="true" /><Input id="customer-search" type="search" placeholder="Search name or organization" value={query} onChange={event => setQuery(event.target.value)} /></div>
            <label className="sr-only" htmlFor="business-filter">Filter by business</label><select id="business-filter" className="native-select" value={business} onChange={event => setBusiness(event.target.value)}><option value="">All businesses</option>{businesses.map(item => <option key={item}>{item}</option>)}</select>
          </div>
          <nav aria-label="Customers" className="customer-list">
            {filtered.map(item => <a href={`#${encodeURIComponent(item.id)}`} className={`customer-row ${route === item.id ? 'is-selected' : ''}`} aria-current={route === item.id ? 'page' : undefined} key={item.id}>
              <span className="customer-avatar" aria-hidden="true">{item.name.slice(0, 1).toUpperCase()}</span><span className="customer-row-content"><span className="customer-name">{item.name}</span><span className="customer-business">{item.business}</span><Status customer={item} running={data.jobs.some(job => job.customerId === item.id && job.state === 'running')} /></span><ChevronRight className="row-chevron" aria-hidden="true" />
            </a>)}
            {loaded && filtered.length === 0 && <div className="directory-empty"><p>{data.customers.length ? 'No matching customers.' : 'Your customer connections will appear here.'}</p>{(query || business) && <Button variant="ghost" onClick={() => { setQuery(''); setBusiness('') }}>Clear filters</Button>}</div>}
          </nav>
          <p className="sidebar-note"><ShieldCheck aria-hidden="true" />Each project keeps its own customer binding.</p>
        </aside>
        <main id="main-content" className="main-content" tabIndex={-1}>
          {error && <Notice tone="error"><strong>Cannot refresh the local router.</strong><p>{error}</p><Button variant="outline" onClick={() => void load(true)}>Try again</Button></Notice>}
          {!loaded && !error ? <div className="page-loading" role="status"><RefreshCw className="busy-icon" aria-hidden="true" />Loading customer connections…</div> : customer ? <CustomerDetail key={customer.id} customer={customer} bindings={data.bindings.filter(item => item.customerId === customer.id)} jobs={data.jobs.filter(item => item.customerId === customer.id)} headingRef={detailHeading} unavailable={!!error} refresh={load} jobStarted={jobStarted} announce={setAnnouncement} /> : route && loaded ? <div className="empty-page"><h1>Customer not found</h1><p>This entry may have been removed.</p><a href="#" className="text-link">Return to customers</a></div> : <div className="overview">
            <span className="eyebrow">Workspace access</span><h1>{data.customers.length ? 'Choose a customer to continue.' : 'Keep customer connections separate.'}</h1><p className="intro">Keep each Glide organization connected to the right project. Verify its identity, then review the settings for Claude Code and Codex.</p>
            <Button onClick={event => { newCustomerTrigger.current = event.currentTarget; setCreating(true) }} disabled={!loaded || !!error}><Plus aria-hidden="true" />Add customer</Button>
            <div className="setup-steps"><section><span className="step-number">01</span><h2>Save the customer</h2><p>Use the organization ID from the customer’s Glide URL.</p></section><section><span className="step-number">02</span><h2>Verify the connection</h2><p>Sign in through Glide and check the returned organization.</p></section><section><span className="step-number">03</span><h2>Bind a project</h2><p>Review the generated files before writing the project settings.</p></section></div>
            <div className="overview-footnote"><Folder aria-hidden="true" /><p>Open that same project in T3 Code, Claude Code, or Codex. The project settings keep its customer attached.</p></div>
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
      <DialogHeader><DialogTitle>Add customer</DialogTitle><DialogDescription>Save the intended Glide organization before connecting it.</DialogDescription></DialogHeader>
      <form className="dialog-form" onSubmit={submit}>
        <DialogPanel className="grid gap-5">
          {error && <Notice tone="error">{error}</Notice>}
          <Field id="new-name" label="Customer name"><Input id="new-name" name="name" required maxLength={100} autoComplete="off" autoFocus placeholder="Customer name" /></Field>
          <Field id="new-business" label="Business" hint="A label for organizing your customer list."><Input id="new-business" name="business" required maxLength={100} autoComplete="off" list="business-options" aria-describedby="new-business-hint" placeholder="Business name" /><datalist id="business-options">{businesses.map(value => <option value={value} key={value} />)}</datalist></Field>
          <Field id="new-org" label="Expected organization ID" hint="Open this customer’s Glide organization. Copy its organization ID from the address bar. Use the ID, not the organization name."><Input id="new-org" name="expectedOrgId" required autoComplete="off" spellCheck={false} aria-describedby="new-org-hint" placeholder="Paste organization ID" /></Field>
          <details className="advanced-settings"><summary>Connection settings</summary><Field id="new-server" label="MCP server URL"><Input id="new-server" name="serverUrl" type="url" required defaultValue="https://mcp.glideapps.dev/mcp" autoComplete="off" spellCheck={false} /></Field></details>
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
    <header className="detail-header"><div><p className="eyebrow">{customer.business}</p><h1 ref={headingRef} tabIndex={-1}>{customer.name}</h1><p className="detail-subtitle">Glide connection and project access</p></div><Status customer={customer} running={running} /></header>
    <Card className="connection-card"><CardPanel className="p-6">
      <div className="section-heading"><div><h2>Connection</h2><p>Check the organization before using its tools.</p></div><span className="section-icon"><Link2 aria-hidden="true" /></span></div>
      <dl className="identity-grid"><div><dt>Expected organization</dt><dd className="mono">{customer.expectedOrgId}</dd></div><div><dt>Last returned organization</dt><dd className="mono">{customer.lastCheck?.observedOrgId || 'Not verified yet'}</dd></div><div><dt>MCP server</dt><dd className="mono">{customer.serverUrl}</dd></div><div><dt>Last identity check</dt><dd>{dateLabel(customer.lastCheck?.checkedAt)}</dd></div></dl>
      {customer.lastCheck?.message && <Notice tone={customer.lastCheck.state === 'verified' ? 'success' : customer.lastCheck.state === 'unverified' ? 'info' : 'error'}>{customer.lastCheck.message}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {starting === 'connect' && !runningJob && <Notice>Preparing Glide sign-in…</Notice>}
      {!unavailable && runningJob?.authorizationUrl && <Notice><strong>Continue in Glide</strong><p>Choose this customer’s Glide organization, then return here to finish the identity check.</p><Button variant="outline" render={<a href={runningJob.authorizationUrl} target="_blank" rel="noopener noreferrer" />}>Open Glide sign-in</Button></Notice>}
      {latestJob && <div className={`job-status ${latestJob.state === 'failed' ? 'job-failed' : ''}`} role="status"><span>{latestJob.state === 'running' ? <RefreshCw className="busy-icon" aria-hidden="true" /> : latestJob.state === 'failed' ? <CircleAlert aria-hidden="true" /> : <Check aria-hidden="true" />}</span><div><strong>{latestJob.state === 'running' ? 'Connection in progress' : latestJob.state === 'failed' ? 'Connection job failed' : 'Connection job finished'}</strong><p>{latestJob.message}</p></div></div>}
      <div className="connection-actions"><Button onClick={() => void run('connect')} loading={starting === 'connect'} disabled={running || unavailable}><Link2 aria-hidden="true" />{verified ? 'Reconnect Glide' : 'Connect Glide'}</Button><Button variant="outline" onClick={() => void run('check')} loading={starting === 'check'} disabled={running || unavailable}><ShieldCheck aria-hidden="true" />Check identity</Button></div>
      <p className="field-hint connection-hint">A saved entry becomes verified only after Glide returns the expected organization ID.</p>
    </CardPanel></Card>
    <ProjectBinding customer={customer} bindings={bindings} unavailable={unavailable || running} refresh={refresh} announce={announce} />
    <details className="usage-help"><summary>Use this connection in your coding tools</summary><div><p>Open the bound project folder in T3 Code, Claude Code, or Codex. Start a new agent session after applying settings so the client can load them.</p><p>Review any project trust or MCP approval prompt from the client. Check the visible tool identity before customer work. A configuration write confirms that the files were saved; it does not confirm that a running client loaded them.</p></div></details>
    <footer className="detail-footer"><p>Saved {dateLabel(customer.createdAt)}</p><Dialog open={removeOpen} onOpenChange={next => { if (!removing) setRemoveOpen(next) }}><DialogTrigger render={<Button variant="ghost" disabled={bindings.length > 0 || running || unavailable} />}>Remove saved entry</DialogTrigger><DialogPopup showCloseButton={false} bottomStickOnMobile={false}><DialogHeader><DialogTitle>Remove {customer.name}?</DialogTitle><DialogDescription>This removes the saved customer entry. Protected local sign-in files remain available for recovery. Glide access is not revoked.</DialogDescription></DialogHeader><DialogFooter><DialogClose render={<Button variant="ghost" disabled={removing} />}>Cancel</DialogClose><Button variant="destructive" loading={removing} onClick={() => void remove()}>Remove saved entry</Button></DialogFooter></DialogPopup></Dialog></footer>
    {bindings.length > 0 && <p className="removal-note">This entry has bound projects and cannot be removed.</p>}
  </article>
}

function ProjectBinding({ customer, bindings, unavailable, refresh, announce }: { customer: Customer; bindings: RouterState['bindings']; unavailable: boolean; refresh: () => Promise<RouterState | null>; announce: (message: string) => void }) {
  const [path, setPath] = useState('')
  const [plan, setPlan] = useState<Plan | null>(null)
  const [busy, setBusy] = useState<'preview' | 'apply' | null>(null)
  const [error, setError] = useState('')
  const [applied, setApplied] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const previewRef = useRef<HTMLHeadingElement>(null)
  const verified = customer.lastCheck?.state === 'verified'
  useEffect(() => { if (plan) previewRef.current?.focus() }, [plan])
  async function preview(event: FormEvent) {
    event.preventDefault(); setBusy('preview'); setError(''); setApplied(''); setPlan(null); setAcknowledged(false)
    try { setPlan(await post<Plan>('/api/projects/preview', { customerId: customer.id, projectPath: path.trim() })) }
    catch (e) { setError(errorMessage(e)) } finally { setBusy(null) }
  }
  async function apply() {
    if (!plan) return
    setBusy('apply'); setError('')
    try {
      const result = await post<{ ok: true; projectPath: string }>('/api/projects/apply', { planId: plan.planId })
      setApplied(result.projectPath); setPlan(null); await refresh(); announce('Project settings saved. Start a new agent session to load them.')
    } catch (e) { setError(errorMessage(e)); setPlan(null) } finally { setBusy(null) }
  }
  return <section className="project-section">
    <div className="section-heading"><div><h2>Project bindings</h2><p>Each folder uses one customer connection.</p></div><Badge variant="secondary">{bindings.length}</Badge></div>
    {bindings.length > 0 && <ul className="bound-projects">{bindings.map(binding => <li key={binding.path}><Folder aria-hidden="true" /><div><button className="path-button mono" onClick={() => { setPath(binding.path); setPlan(null); setApplied(''); setError('') }}>{binding.path}</button><p>Settings saved {dateLabel(binding.createdAt)}</p></div><Badge variant="outline">Bound</Badge></li>)}</ul>}
    <form className="project-form" onSubmit={preview}>
      <Field id="project-path" label={bindings.length ? 'Bind another project' : 'Project folder'} hint="Paste the full path to an existing folder on this Mac."><div className="project-input-row"><Input id="project-path" name="projectPath" value={path} onChange={event => { setPath(event.target.value); setPlan(null); setError(''); setApplied('') }} required autoComplete="off" spellCheck={false} placeholder="/Users/you/Projects/customer-project" aria-describedby="project-path-hint" disabled={busy !== null} /><Button type="submit" variant="outline" loading={busy === 'preview'} disabled={busy !== null || unavailable}>Review settings<ArrowRight aria-hidden="true" /></Button></div></Field>
    </form>
    {error && <Notice tone="error">{error}<p>Review the settings again before applying.</p></Notice>}
    {applied && <Notice tone="success"><strong>Project settings saved</strong><p className="mono break-anywhere">{applied}</p><p>Start a new session in your coding tool. Confirm the project is trusted and its customer connection is available.</p></Notice>}
    {plan && <div className="config-review"><div className="review-heading"><div><p className="eyebrow">Review before applying</p><h3 ref={previewRef} tabIndex={-1}>Settings for {customer.name}</h3><p className="mono break-anywhere">{plan.projectPath}</p></div><Badge variant="outline">Preview</Badge></div>
      {!verified && <Notice tone="warning">Verify this customer’s Glide identity before applying the project settings.</Notice>}
      {plan.warnings.length > 0 && <Notice tone="warning"><strong>Review existing connections</strong><ul>{plan.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></Notice>}
      <p className="preview-caption">Generated entries for this customer. Existing file contents may also remain in each file.</p>
      <div className="preview-files">{plan.files.map(file => <details key={file.path} open><summary><span className="mono">{file.path}</span><Badge variant={file.changed ? 'info' : 'secondary'}>{file.changed ? 'Will change' : 'No change'}</Badge></summary><pre tabIndex={0} aria-label={`Generated settings for ${file.path}`}><code>{file.content}</code></pre></details>)}</div>
      {plan.warnings.length > 0 && <label className="warning-acknowledgment"><input type="checkbox" checked={acknowledged} onChange={event => setAcknowledged(event.target.checked)} /><span>I reviewed the existing connection warnings.</span></label>}
      <div className="review-actions"><Button variant="ghost" disabled={busy === 'apply'} onClick={() => setPlan(null)}>Cancel review</Button><Button onClick={() => void apply()} loading={busy === 'apply'} disabled={!verified || unavailable || (plan.warnings.length > 0 && !acknowledged)}>Apply project settings</Button></div>
    </div>}
  </section>
}
