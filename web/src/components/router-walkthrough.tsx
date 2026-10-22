import { useEffect, useId, useRef, useState } from 'react'
import { ArrowDown, ArrowRight, Check, FileCode2, Folder, Info, Link2, LockKeyhole, Plus, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogPopup, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { ClientGuide, ClientPicker } from '@/components/client-setup'
import type { ClientId } from '@/lib/client-setup'

const STORAGE_KEY = 'mcp-customer-router.walkthrough.v1'
export function shouldShowWalkthrough() {
  try { return window.localStorage.getItem(STORAGE_KEY) !== 'dismissed' }
  catch { return true }
}
const titles = ['One connection per customer', 'Add your customer', 'Sign in to Glide', 'Link a project folder', 'Choose your AI app']

function TourExample({ step }: { step: number }) {
  return <figure className="tour-example">
    <div className="tour-scene" key={step} aria-hidden="true">
      {step === 0 && <div className="tour-map">
        <div className="tour-map-node"><Terminal /><div><strong>Your AI app</strong><span>Customer project folder</span></div></div>
        <ArrowDown className="tour-connector" />
        <div className="tour-map-node tour-router-node"><img src="/glide-mark.svg" width="24" height="24" alt="" /><div><strong>MCP router</strong><span>customer-glide</span></div><LockKeyhole className="tour-node-end" /></div>
        <ArrowDown className="tour-connector" />
        <div className="tour-map-node"><div className="tour-initial">A</div><div><strong>Acme Studio</strong><span>Saved Glide sign-in</span></div><Check className="tour-node-end" /></div>
        <div className="tour-separated"><div className="tour-initial">N</div><div><strong>Northstar</strong><span>Separate saved sign-in</span></div><LockKeyhole className="tour-node-end" /></div>
      </div>}
      {step === 1 && <div className="tour-window">
        <div className="tour-window-header"><span>Add customer</span><Plus /></div>
        <div className="tour-form-demo"><span>Customer name</span><div>Acme Studio</div><span>Business</span><div>Your agency</div><span>Expected organization ID</span><div className="mono">acme-studio</div></div>
        <div className="tour-window-actions"><span className="tour-button">Save customer</span></div>
      </div>}
      {step === 2 && <div className="tour-window">
        <div className="tour-window-header"><span>Acme Studio</span><Link2 /></div>
        <div className="tour-signin"><img src="/glide-mark.svg" width="36" height="36" alt="" /><strong>Choose your organization</strong><div className="tour-org-choice"><span>Acme Studio</span><Check /></div><div className="tour-org-choice tour-org-other"><span>Northstar</span></div></div>
        <div className="tour-result"><Check /><span>Organization matches Acme Studio</span></div>
      </div>}
      {step === 3 && <div className="tour-window">
        <div className="tour-window-header"><Folder /><span>Acme project</span></div>
        <div className="tour-config-demo"><div><FileCode2 /><span>.mcp.json</span><Check /></div><div><FileCode2 /><span>.codex/config.toml</span><Check /></div><p>customer-glide → Acme Studio</p></div>
        <div className="tour-review-demo"><strong>Other Glide connections</strong><div><span>glideos</span><span className="tour-chip tour-chip-selected">Remove</span><span className="tour-chip">Ignore</span></div><small>Settings backed up before removal</small></div>
        <div className="tour-window-actions"><span className="tour-button">Apply and remove 1</span></div>
      </div>}
    </div>
    <figcaption>Example {step === 0 ? 'connection' : step === 1 ? 'customer' : step === 2 ? 'sign-in' : 'project setup'}</figcaption>
  </figure>
}

export function RouterWalkthrough({ open, onOpenChange, client, onClientChange }: { open: boolean; onOpenChange: (open: boolean) => void; client: ClientId; onClientChange: (id: ClientId) => void }) {
  const [step, setStep] = useState(0)
  const titleRef = useRef<HTMLHeadingElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const progressId = useId()
  useEffect(() => { if (open) titleRef.current?.focus() }, [open, step])
  function changeOpen(next: boolean) {
    if (next) setStep(0)
    else { try { window.localStorage.setItem(STORAGE_KEY, 'dismissed') } catch { /* Dismiss for this visit. */ } }
    onOpenChange(next)
  }
  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogTrigger render={<Button ref={triggerRef} variant="ghost" className="icon-button" />} aria-label="How to use the router" title="How to use the router"><Info aria-hidden="true" /></DialogTrigger>
    <DialogPopup className="walkthrough-dialog" bottomStickOnMobile={false} initialFocus={titleRef} finalFocus={triggerRef} closeProps={{ 'aria-label': 'Close walkthrough', title: 'Close walkthrough' }}>
      <div className="tour-body">
        <div className="tour-copy">
          <DialogTitle ref={titleRef} tabIndex={-1} aria-describedby={progressId}>{titles[step]}</DialogTitle>
          <DialogDescription className="sr-only">Set up and use a customer’s Glide connection.</DialogDescription>
          <div className="walkthrough-content">
            {step === 0 && <>
              <p>Sign in to a customer’s Glide organization once. Use that saved connection across your local AI apps.</p>
              <p>The project folder tells the router which customer to use. Each customer keeps a separate sign-in.</p>
              <p className="walkthrough-note">You still need an account for each AI service.</p>
              <details className="tour-daily-use"><summary>Saved data and daily use</summary><p>Connections and sign-ins stay on this Mac in <code>~/.mcp-customer-router/</code> by default. You can close the dashboard; the Mac must stay awake.</p><p>Run <code>mcp-customer-router open</code> to return. <strong>Check identity</strong> tests saved access. <strong>Reconnect Glide</strong> starts a fresh sign-in; restart that customer’s active sessions afterward.</p></details>
            </>}
            {step === 1 && <>
              <p>Select <strong>New</strong> in the customer list. Enter a name, business, and Glide organization ID.</p>
              <p>The organization ID is the part after <code>/o/</code> in the Glide URL. Then select <strong>Save customer</strong>.</p>
              <p className="walkthrough-note">Add one customer entry per organization. Use the business label to group your customers.</p>
            </>}
            {step === 2 && <>
              <p>Select <strong>Connect Glide</strong>. Choose this customer’s organization in the browser.</p>
              <p>The router checks that the organization matches the saved ID before it allows tool access.</p>
              <p className="walkthrough-note">If the browser stays closed, use <strong>Open Glide sign-in</strong>.</p>
            </>}
            {step === 3 && <>
              <p>Select <strong>Choose folder</strong>, then <strong>Preview config</strong>. The router prepares the project settings for Claude and Codex.</p>
              <p>If other Glide connections appear, choose <strong>Remove</strong> or <strong>Ignore</strong> for each. Removal happens when you apply, with a settings backup.</p>
              <p className="walkthrough-note">Check the scope: a user-wide entry can serve other projects. Ignore keeps its settings. New folders and worktrees need their own setup.</p>
            </>}
            {step === 4 && <>
              <p>Choose the app you use to see its setup steps.</p>
              <ClientPicker value={client} onChange={onClientChange} />
              <p className="walkthrough-note">You can return to these steps from <strong>Client setup</strong> in the header.</p>
            </>}
          </div>
          {step < 4 && <div className="tour-step-labels" aria-label="Walkthrough progress">{titles.map((title, index) => <span key={title} className={index === step ? 'current' : index < step ? 'complete' : ''} aria-current={index === step ? 'step' : undefined}><span className="sr-only">{title}</span></span>)}</div>}
        </div>
        <div className={`tour-right ${step === 4 ? 'tour-client-panel' : ''}`}>{step === 4 ? <ClientGuide client={client} /> : <TourExample step={step} />}</div>
      </div>
      <DialogFooter className="walkthrough-footer"><span id={progressId} className="walkthrough-progress">Step {step + 1} of {titles.length}</span><div className="walkthrough-actions">{step > 0 && <Button variant="ghost" onClick={() => setStep(step - 1)}>Back</Button>}{step < titles.length - 1 ? <Button onClick={() => setStep(step + 1)}>Next<ArrowRight aria-hidden="true" /></Button> : <DialogClose render={<Button />}>Done</DialogClose>}</div></DialogFooter>
    </DialogPopup>
  </Dialog>
}
