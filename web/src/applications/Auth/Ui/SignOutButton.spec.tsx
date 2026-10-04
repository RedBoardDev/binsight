import { renderAppAt } from '@test/renderAppAt';
import { signedInSession, signedOutSession, stubApi } from '@test/stubApi';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

describe('SignOutButton', () => {
  it('signs out and opens the login page', async () => {
    let isSignedIn = true;
    stubApi({
      'GET /api/v1/auth/session': () => (isSignedIn ? signedInSession() : signedOutSession()),
      'POST /api/v1/auth/logout': () => {
        isSignedIn = false;
        return new Response(null, { status: 204 });
      },
    });
    const user = userEvent.setup();
    const { router } = renderAppAt('/settings');

    await user.click(await screen.findByRole('button', { name: 'Sign out' }));

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
  });

  it('stays signed in and says so when the server cannot sign out', async () => {
    stubApi({ 'GET /api/v1/auth/session': signedInSession });
    const user = userEvent.setup();
    const { router } = renderAppAt('/settings');

    await user.click(await screen.findByRole('button', { name: 'Sign out' }));

    expect(await screen.findByText('Could not sign out.')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/settings');
  });
});
