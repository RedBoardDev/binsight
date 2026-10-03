import type { LIVE_EVENT_TYPES, LiveEvent } from '@app/applications/Realtime/Domain/liveEvent';
import type { ApiSchema } from '@app/lib/api/apiSchema';
import { describe, expectTypeOf, it } from 'vitest';

type ContractLiveEvent = ApiSchema<'LiveEvent'>;

// Checked by the typecheck, not at run time: an event added to the Rust contract fails
// `pnpm typecheck` until the web app parses and listens to it.
describe('the live event parser', () => {
  it('reads exactly the events of the API contract', () => {
    expectTypeOf<LiveEvent>().toEqualTypeOf<ContractLiveEvent>();
  });

  it('listens to every event type of the API contract', () => {
    expectTypeOf<(typeof LIVE_EVENT_TYPES)[number]>().toEqualTypeOf<ContractLiveEvent['type']>();
  });
});
