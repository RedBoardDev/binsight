export const ENTITY_NAMES = ['Health', 'Session', 'Overview'] as const;

export type EntityName = (typeof ENTITY_NAMES)[number];
