/**
 * The tiny async-data primitive every page shares: one state machine
 * (`loading → ready | error`) for every controller call, and one gate component
 * that renders the API's own error message — never a client-side replacement.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react';

import { ApiError, type ApiClient } from '../api/client';

export type AsyncState<T> =
  | { status: 'loading' }
  | { status: 'ready'; data: T }
  | { status: 'error'; error: ApiError };

/** A controller call re-run when `deps` change; stale runs never overwrite newer ones. */
export function useAsync<T>(load: () => Promise<T>, deps: readonly unknown[]): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: 'loading' });
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    loadRef
      .current()
      .then((data) => {
        if (!cancelled) setState({ status: 'ready', data });
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setState({
            status: 'error',
            error:
              error instanceof ApiError
                ? error
                : // A controller bug (never an API response): surfaced honestly as an internal
                  // error, mirroring how `apps/api` reports its own unhandled errors.
                  new ApiError('internal', `UI controller failed: ${String(error)}`, 0),
          });
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- deps are the caller's contract
  }, deps);

  return state;
}

/** Render the three states. The error panel shows the API's error envelope verbatim. */
export function AsyncGate<T>(props: {
  state: AsyncState<T>;
  children: (data: T) => ReactNode;
}): ReactNode {
  const { state } = props;
  if (state.status === 'loading') {
    return <p className="state state-loading">Loading…</p>;
  }
  if (state.status === 'error') {
    return (
      <section className="state state-error" aria-live="polite">
        <h3>
          API error <code>{state.error.code}</code> (HTTP {state.error.status})
        </h3>
        <p>{state.error.message}</p>
      </section>
    );
  }
  return <>{props.children(state.data)}</>;
}

/** Convenience: the pages never read the client directly — they go through a controller. */
export type Api = ApiClient;
