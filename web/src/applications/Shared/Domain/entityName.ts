export const ENTITY_NAMES = ['Health', 'Session'] as const;

export type EntityName = (typeof ENTITY_NAMES)[number];
