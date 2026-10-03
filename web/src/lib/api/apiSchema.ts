import type { components } from '@app/lib/api/generated/openapi';

export type ApiSchema<Name extends keyof components['schemas']> = components['schemas'][Name];
