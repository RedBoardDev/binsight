import {
  SCOPE_SEARCH_DEFAULTS,
  SCOPE_SEARCH_KEYS,
  type ScopeSearch,
  scopeSearchSchema,
} from '@app/applications/Shared/Scope/Domain/scopeSearch';
import { retainSearchParams, stripSearchParams } from '@tanstack/react-router';

export const scopeRouteOptions = {
  validateSearch: scopeSearchSchema,
  search: {
    // The outer middleware runs last: the retained values are stripped when they are defaults.
    middlewares: [
      stripSearchParams<ScopeSearch>(SCOPE_SEARCH_DEFAULTS),
      retainSearchParams<ScopeSearch>([...SCOPE_SEARCH_KEYS]),
    ],
  },
};
