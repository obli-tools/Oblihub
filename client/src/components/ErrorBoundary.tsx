import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RotateCcw } from 'lucide-react';

interface Props { children: ReactNode }
interface State { error: Error | null }

/**
 * Keeps a render error inside the page that threw it. Without a boundary React unmounts the whole
 * tree, header and sidebar included, and the tab goes blank: e.g. when a server older or newer than
 * this bundle sends a payload without a field a page reads unguarded (the client and server
 * containers are updated one after the other). AppLayout keys it by path, so navigating clears it.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Page render failed', error, info.componentStack);
  }

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="p-6">
        <div className="max-w-2xl rounded-lg border border-status-down/30 bg-status-down/5 p-4">
          <div className="mb-1 flex items-center gap-2 text-sm font-semibold text-status-down">
            <AlertTriangle size={14} /> This page failed to render
          </div>
          <p className="mb-2 text-xs text-text-secondary">
            The rest of Oblihub still works. If the server was just updated, reloading fetches the matching interface.
          </p>
          <pre className="mb-3 whitespace-pre-wrap break-words rounded bg-bg-tertiary p-2 font-mono text-xs text-text-muted">{error.message}</pre>
          <div className="flex gap-2">
            <button onClick={() => window.location.reload()} className="flex items-center gap-2 px-3 py-1.5 text-sm rounded-lg border border-border text-text-secondary hover:bg-bg-hover">
              <RotateCcw size={14} /> Reload
            </button>
            <button onClick={() => this.setState({ error: null })} className="px-3 py-1.5 text-sm rounded-lg text-text-muted hover:text-text-primary hover:bg-bg-hover">
              Try again
            </button>
          </div>
        </div>
      </div>
    );
  }
}
