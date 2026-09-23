/**
 * Auth endpoints live outside the BFF proxy (they manage the httpOnly cookie directly). Identity is
 * the Solana wallet address; a one-time signature is required only at register and password reset.
 */

/** Result of asking the backend for a signature challenge (register / reset step 1). */
type NonceResult =
  | { ok: true; nonce: string; message: string }
  | { ok: false; status: number; error?: string; notWhitelisted?: boolean };

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** POST to an auth endpoint and normalise the {ok}|{ok:false,error} result (login/register/reset). */
async function postAuth(
  path: string,
  body: unknown,
): Promise<{ ok: boolean; error?: string; signatureRequired?: boolean }> {
  const res = await postJson(path, body);
  if (res.ok) return { ok: true };
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    signatureRequired?: boolean;
  };
  return { ok: false, error: data.error, signatureRequired: data.signatureRequired === true };
}

/**
 * Auth endpoints live outside the proxy (they manage the httpOnly cookie directly). Identity is the
 * Solana wallet address; the one-time signature is required only at register and password reset.
 */
export const authApi = {
  /** Register step 1 / reset step 1 — fetch the challenge to sign. */
  async nonce(address: string, kind: 'register' | 'reset'): Promise<NonceResult> {
    const res = await postJson(kind === 'register' ? '/api/auth/nonce' : '/api/auth/reset/nonce', {
      address,
    });
    const data = (await res.json().catch(() => ({}))) as {
      nonce?: string;
      message?: string;
      error?: string;
      notWhitelisted?: boolean;
    };
    if (res.ok && data.nonce && data.message) {
      return { ok: true, nonce: data.nonce, message: data.message };
    }
    return {
      ok: false,
      status: res.status,
      error: data.error,
      notWhitelisted: data.notWhitelisted,
    };
  },

  login(address: string, password: string): Promise<{ ok: boolean; error?: string }> {
    return postAuth('/api/auth/login', { address, password });
  },

  // In open-access mode the backend ignores signature/nonce, so the simplified signup omits them.
  register(p: {
    address: string;
    password: string;
    signature?: string;
    nonce?: string;
  }): Promise<{ ok: boolean; error?: string }> {
    return postAuth('/api/auth/register', p);
  },

  reset(p: {
    address: string;
    signature: string;
    nonce: string;
    password: string;
  }): Promise<{ ok: boolean; error?: string }> {
    return postAuth('/api/auth/reset', p);
  },

  async logout(): Promise<void> {
    await fetch('/api/auth/logout', { method: 'POST' });
  },

  async wsTicket(): Promise<string | null> {
    const res = await fetch('/api/auth/ws-ticket');
    if (!res.ok) return null;
    const { token } = (await res.json()) as { token: string };
    return token;
  },
};
