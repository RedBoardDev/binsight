import { HealthCard } from '@app/applications/Health/Ui/HealthCard';
import { healthyServer } from '@test/fixtures/health';
import { renderWithProviders } from '@test/renderWithProviders';
import { errorResponse, jsonResponse, stubApi } from '@test/stubApi';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';

const HEALTHY = healthyServer();

describe('HealthCard', () => {
  it('shows the status, the version and each component of a healthy server', async () => {
    stubApi({ 'GET /api/v1/health': () => jsonResponse(200, HEALTHY) });
    renderWithProviders(<HealthCard />);

    expect(await screen.findByText('Healthy')).toBeInTheDocument();
    expect(screen.getByText('0.1.0')).toBeInTheDocument();
    expect(screen.getByText('Available')).toBeInTheDocument();
    expect(screen.getByText('Running')).toBeInTheDocument();
  });

  it('shows the report of a server whose database does not answer', async () => {
    stubApi({
      'GET /api/v1/health': () =>
        jsonResponse(503, healthyServer({ status: 'unavailable', database: 'unavailable' })),
    });
    renderWithProviders(<HealthCard />);

    expect(await screen.findAllByText('Unavailable')).toHaveLength(2);
  });

  it('tells a degraded server from an unavailable one', async () => {
    stubApi({
      'GET /api/v1/health': () =>
        jsonResponse(200, healthyServer({ status: 'degraded', rpc: 'unavailable' })),
    });
    renderWithProviders(<HealthCard />);

    expect(await screen.findByText('Degraded')).toBeInTheDocument();
  });

  it('offers to try again when the health cannot be read', async () => {
    let isBroken = true;
    stubApi({
      'GET /api/v1/health': () =>
        isBroken ? errorResponse(500, 'internal') : jsonResponse(200, HEALTHY),
    });
    const user = userEvent.setup();
    renderWithProviders(<HealthCard />);

    expect(await screen.findByText('The server health could not be read.')).toBeInTheDocument();
    isBroken = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));

    expect(await screen.findByText('Healthy')).toBeInTheDocument();
  });
});
