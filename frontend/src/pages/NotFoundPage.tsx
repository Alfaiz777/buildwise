import { Link } from 'react-router-dom';

export function NotFoundPage() {
  return (
    <main className="card">
      <h1>Page not found</h1>
      <Link to="/">Back to Buildwise</Link>
    </main>
  );
}
