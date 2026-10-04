import { activeSession } from '@test/fixtures/session';
import { renderAppAt } from '@test/renderAppAt';
import {
  errorResponse,
  jsonResponse,
  signedInSession,
  signedOutSession,
  stubApi,
} from '@test/stubApi';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

const SESSION = activeSession();

const openLoginPage = async (path = '/login') => {
  const user = userEvent.setup();
  const app = renderAppAt(path);
  await screen.findByRole('button', { name: 'Sign in' });
  return { user, ...app };
};

describe('LoginForm', () => {
  it('asks for the password before sending anything', async () => {
    const fetchStub = stubApi({ 'GET /api/v1/auth/session': signedOutSession });
    const { user } = await openLoginPage();

    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Enter the password.')).toBeInTheDocument();
    expect(fetchStub).toHaveBeenCalledOnce();
  });

  it('shows the field error when the password is wrong', async () => {
    stubApi({
      'GET /api/v1/auth/session': signedOutSession,
      'POST /api/v1/auth/login': () => errorResponse(401, 'invalid_credentials'),
    });
    const { user } = await openLoginPage();

    await user.type(screen.getByLabelText('Password'), 'wrong password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Incorrect password.')).toBeInTheDocument();
  });

  it('says how long to wait after too many failed attempts', async () => {
    stubApi({
      'GET /api/v1/auth/session': signedOutSession,
      'POST /api/v1/auth/login': () =>
        errorResponse(429, 'too_many_attempts', { 'retry-after': '30' }),
    });
    const { user } = await openLoginPage();

    await user.type(screen.getByLabelText('Password'), 'wrong password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Too many failed attempts. Try again in 30 seconds.',
    );
  });

  it('opens the page the owner was going to once signed in', async () => {
    let isSignedIn = false;
    stubApi({
      'GET /api/v1/auth/session': () => (isSignedIn ? signedInSession() : signedOutSession()),
      'POST /api/v1/auth/login': () => {
        isSignedIn = true;
        return jsonResponse(200, SESSION);
      },
    });
    const { user, router } = await openLoginPage('/login?redirect=%2Fdoes-not-exist');

    await user.type(screen.getByLabelText('Password'), 'correct horse battery staple');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/does-not-exist');
  });
});
