import { useId } from 'react'
import { Button } from '@/components/ui/button'
import type { ConnectionAction, ExistingConnection } from '@/lib/api'
import './connection-review.css'

interface ConnectionReviewProps {
  connections: ExistingConnection[]
  actions: ConnectionAction[]
  onChange: (action: ConnectionAction) => void
  disabled?: boolean
}

const scopes = {
  project: 'This project',
  user: 'All projects',
  'project-private': 'This project, private settings',
}

export function ConnectionReview({ connections, actions, onChange, disabled = false }: ConnectionReviewProps) {
  const id = useId()
  if (!connections.length) return null

  const removed = actions.filter(action => action.action === 'remove')
  const affectsOtherProjects = connections.some(connection => connection.scope === 'user' && removed.some(action => action.id === connection.id))
  const undecided = connections.filter(connection => !actions.some(action => action.id === connection.id)).length

  return <section className="connection-review" aria-labelledby={`${id}-heading`}>
    <h4 id={`${id}-heading`}>Other Glide connections</h4>
    <p className="connection-review-intro">Choose Remove or Ignore for each saved connection. Ignore leaves its settings unchanged. Your choices take effect when you apply.</p>
    <ul className="connection-review-list">
      {connections.map((connection, index) => {
        const action = actions.find(item => item.id === connection.id)?.action
        const rowId = `${id}-${index}`
        return <li className="connection-review-row" key={connection.id}>
          <div className="connection-review-details">
            <div className="connection-review-title"><strong id={`${rowId}-name`}>{connection.name}</strong><span>{connection.client === 'claude' ? 'Claude' : 'Codex'}</span></div>
            <p className="connection-review-path mono">{connection.filePath}</p>
            <p className="connection-review-scope">{scopes[connection.scope]}{connection.scope === 'user' ? '. Removal also affects other projects.' : ''}</p>
            {!connection.removable && <p className="connection-review-reason" id={`${rowId}-reason`}>{connection.reason || 'This connection cannot be removed here.'}</p>}
          </div>
          <div className="connection-review-options" role="group" aria-labelledby={`${rowId}-name`}>
            <Button variant="outline" aria-pressed={action === 'remove'} disabled={disabled || !connection.removable} aria-describedby={!connection.removable ? `${rowId}-reason` : undefined} onClick={() => onChange({ id: connection.id, action: 'remove' })}>Remove</Button>
            <Button variant="outline" aria-pressed={action === 'ignore'} disabled={disabled} onClick={() => onChange({ id: connection.id, action: 'ignore' })}>Ignore</Button>
          </div>
        </li>
      })}
    </ul>
    <p className="connection-review-status" role="status">{undecided ? `Choose an option for ${undecided === 1 ? 'the remaining connection' : `the remaining ${undecided} connections`}.` : 'All connections reviewed.'}</p>
    {removed.length > 0 && <p className="connection-review-removal-note">Apply saves a backup before removing the selected entries. Saved sign-in files remain.{affectsOtherProjects && ' Removing user connections also affects other projects.'}</p>}
  </section>
}
