import { renderAppAt } from '@test/renderAppAt';
import { signedInSession, signedOutSession, stubApi } from '@test/stubApi';
import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

describe('the app router', () => {
  it('renders the overview inside the shell at /', async () => {
    stubApi({ 'GET /api/v1/auth/session': signedInSession });
    renderAppAt('/');

    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(screen.getAllByRole('navigation', { name: 'Main' })).toHaveLength(2);
  });

  it('renders the not-found screen inside the shell for an unknown address', async () => {
    stubApi({ 'GET /api/v1/auth/session': signedInSession });
    renderAppAt('/does-not-exist');

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.getAllByRole('navigation', { name: 'Main' })).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Back to the overview' })).toHaveAttribute('href', '/');
  });

  it('sends a signed-out visitor to the login page, remembering where they were going', async () => {
    stubApi({ 'GET /api/v1/auth/session': signedOutSession });
    const { router } = renderAppAt('/does-not-exist?tab=open');

    expect(await screen.findByRole('button', { name: 'Sign in' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/login');
    expect(router.state.location.search).toEqual({ redirect: '/does-not-exist?tab=open' });
  });

  it('sends a signed-in owner from the login page to their destination', async () => {
    stubApi({ 'GET /api/v1/auth/session': signedInSession });
    const { router } = renderAppAt('/login?redirect=%2Fdoes-not-exist');

    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/does-not-exist');
  });

  it('never leaves the site after signing in', async () => {
    stubApi({ 'GET /api/v1/auth/session': signedInSession });
    const { router } = renderAppAt('/login?redirect=%2F%2Fevil.example');

    expect(await screen.findByRole('heading', { name: 'Overview' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/');
  });
});
