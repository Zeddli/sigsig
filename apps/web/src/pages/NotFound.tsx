import { Link } from 'react-router-dom';
import { DEMO_VAULT_ID } from '../config/app';

export function NotFound() {
  return (
    <div className="wrap s-page">
      <h1 className="s-h1">Page not found</h1>
      <p>Nothing lives at this address.</p>
      <p><Link className="btn btn--primary" to={`/vaults/${DEMO_VAULT_ID}`}>Open the demo vault</Link></p>
    </div>
  );
}
