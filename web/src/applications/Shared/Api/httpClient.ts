const inflightGets = new Map<string, Promise<unknown>>();

export class ApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Coalesces concurrent identical GETs into one in-flight request: several components mount and
 * request the same resource in the same React commit, and a closed-set change re-fires every scoped
 * query at once. Cleared the moment the request settles, so it only ever dedupes truly-concurrent
 * calls and never serves a stale response.
 */
export async function apiGet<T>(path: string): Promise<T> {
  const pending = inflightGets.get(path);
  if (pending) return pending as Promise<T>;
  const request = (async (): Promise<T> => {
    const res = await fetch(`/api/${path}`, { headers: { accept: 'application/json' } });
    if (!res.ok) throw new ApiError(`GET ${path} failed (${res.status})`);
    return (await res.json()) as T;
  })();
  inflightGets.set(path, request);
  try {
    return await request;
  } finally {
    inflightGets.delete(path);
  }
}

export async function apiSend(
  path: string,
  method: 'POST' | 'PUT' | 'DELETE',
  body?: unknown,
): Promise<boolean> {
  const res = await fetch(`/api/${path}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return res.ok;
}

export async function apiGetBlob(
  path: string,
  accept: string,
  signal?: AbortSignal,
): Promise<Blob> {
  const res = await fetch(`/api/${path}`, { headers: { accept }, signal });
  if (!res.ok) throw new ApiError(`GET ${path} failed (${res.status})`);
  return res.blob();
}

export const scopeParam = (scope: string): string => encodeURIComponent(scope);
