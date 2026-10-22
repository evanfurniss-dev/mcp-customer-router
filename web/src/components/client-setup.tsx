import { useId, useRef, useState } from 'react'
import { ArrowUpRight, Terminal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogClose, DialogDescription, DialogFooter, DialogHeader, DialogPanel, DialogPopup, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { CLIENT_SETUPS, type ClientId } from '@/lib/client-setup'

const CLIENT_KEY = 'mcp-customer-router.client'
export function useClientChoice() {
  const [client, setClient] = useState<ClientId>(() => {
    try {
      const saved = window.localStorage.getItem(CLIENT_KEY)
      return CLIENT_SETUPS.find(item => item.id === saved)?.id ?? 't3'
    } catch { return 't3' }
  })
  function choose(id: ClientId) {
    setClient(id)
    try { window.localStorage.setItem(CLIENT_KEY, id) } catch { /* Keep the choice for this visit. */ }
  }
  return [client, choose] as const
}

export function ClientPicker({ value, onChange }: { value: ClientId; onChange: (id: ClientId) => void }) {
  const groupId = useId()
  return <fieldset className="client-picker"><legend className="sr-only">Choose your AI app</legend>
    {CLIENT_SETUPS.map(item => <label className={`client-option ${value === item.id ? 'is-selected' : ''}`} key={item.id}>
      <input type="radio" name={groupId} value={item.id} checked={value === item.id} onChange={() => onChange(item.id)} />
      <span>{item.name}</span>
    </label>)}
  </fieldset>
}

export function ClientGuide({ client }: { client: ClientId }) {
  const setup = CLIENT_SETUPS.find(item => item.id === client)!
  return <section className="client-guide" aria-label={`${setup.name} setup`}>
    <h3>{setup.name}</h3><p>{setup.summary}</p>
    <ol>{setup.steps.map((step, i) => <li key={i}>{step}</li>)}</ol>
    {setup.command && <pre className="client-command"><code>{setup.command}</code></pre>}
    {setup.note && <p className="client-note">{setup.note}</p>}
    <div className="client-sources">{setup.docs.map(doc => <a key={doc.url} href={doc.url} target="_blank" rel="noopener noreferrer">{doc.label}<ArrowUpRight aria-hidden="true" /></a>)}</div>
  </section>
}

export function ClientSetup({ client, onClientChange }: { client: ClientId; onClientChange: (id: ClientId) => void }) {
  const [open, setOpen] = useState(false)
  const heading = useRef<HTMLHeadingElement>(null)
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger render={<Button variant="ghost" className="client-setup-trigger" />}><Terminal aria-hidden="true" />Client setup</DialogTrigger>
    <DialogPopup className="client-setup-dialog" bottomStickOnMobile={false} initialFocus={heading}>
      <DialogHeader><DialogTitle ref={heading} tabIndex={-1}>Use the router in your AI app</DialogTitle><DialogDescription>Connect Glide and apply the project settings first. Choose your app for the next steps.</DialogDescription></DialogHeader>
      <DialogPanel className="client-setup-layout"><ClientPicker value={client} onChange={onClientChange} /><ClientGuide client={client} /></DialogPanel>
      <DialogFooter><DialogClose render={<Button />}>Done</DialogClose></DialogFooter>
    </DialogPopup>
  </Dialog>
}
