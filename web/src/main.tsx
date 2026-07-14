import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import ErrorBoundary from './ErrorBoundary.tsx'
import { logErrorToFirebase } from './utils/logger'

window.onerror = (message, _source, _lineno, _colno, error) => {
  const err = error instanceof Error ? error : new Error(String(message || 'Unknown window.onerror error'));
  logErrorToFirebase(err, 'window.onerror');
};

window.onunhandledrejection = (event) => {
  const reason = event.reason;
  const err = reason instanceof Error ? reason : new Error(String(reason || 'Unhandled Promise Rejection'));
  logErrorToFirebase(err, 'window.onunhandledrejection');
};

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
)
