import { useNavigate } from 'react-router-dom';

export function NotFoundPage() {
  const navigate = useNavigate();
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-primary">
      <div className="text-center">
        <h1 className="text-6xl font-bold text-text-muted">404</h1>
        <p className="mt-2 text-text-secondary">Page not found</p>
        <button onClick={() => navigate('/')} className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm text-white hover:bg-accent-hover">
          Go to Dashboard
        </button>
      </div>
    </div>
  );
}
