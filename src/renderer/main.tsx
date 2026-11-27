import React from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import { App } from './App';
import { installWindowVisibilityPause } from './ui/animationVisibility';
import { installAnimationClock } from './ui/animationClock';
import './styles.css';

installWindowVisibilityPause();

interface ErrorBoundaryState {
  error: Error | null;
}

class RootErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error('[super-harness] renderer crash:', error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="h-screen w-screen bg-[#16171b] text-zinc-100 flex items-center justify-center p-6">
          <div className="max-w-lg w-full rounded-2xl border border-white/10 bg-[#1d1f25] p-5 space-y-3 shadow-2xl">
            <div className="text-sm font-semibold text-red-300">
              Super Harness UI encountered a render error
            </div>
            <pre className="text-xs text-zinc-300 bg-black/40 rounded-lg p-3 overflow-auto max-h-48 whitespace-pre-wrap break-words">
              {this.state.error.message}
            </pre>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => this.setState({ error: null })}
                className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/15 text-xs font-medium text-white cursor-pointer"
              >
                Recover UI
              </button>
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-xs font-medium text-white cursor-pointer"
              >
                Reload Window
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

installAnimationClock();

const rootEl = document.getElementById('root');
if (rootEl) {
  createRoot(rootEl).render(
    <React.StrictMode>
      <RootErrorBoundary>
        <App />
      </RootErrorBoundary>
    </React.StrictMode>
  );
}
