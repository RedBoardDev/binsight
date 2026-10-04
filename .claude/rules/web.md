---
paths:
  - "web/**"
---

# Web app

React + TypeScript (strict) + Vite, served as a same-origin SPA by the Rust binary. HeroUI (open-source package only)
+ Tailwind v4 + Lingui (`en` default, `fr`, `de`). TanStack Router and TanStack Query; API client generated from
`openapi/v1.json`. The module rules are enforced by `web/test/architecture.spec.ts` and Biome.

## Structure

- `src/routes/`: routing only. A route file declares the route (path, search validation, guard) and renders one page
  component from a module. No logic, no API call.
- `src/core/`: the shell (layout, router, i18n, theme, query client, PWA, error screens).
- `src/lib/`: infrastructure with no React and no business notion (API client, SSE stream).
- `src/applications/<Entity>/{Api,Domain,Ui}`: one folder per entity, PascalCase singular, exactly three layers.
  - `Domain/`: pure TypeScript (zod and Lingui `msg` allowed). No React, no I/O, no HeroUI, no TanStack.
  - `Api/`: data access: `get<X>.ts` (fetcher), `<x>Query.ts` (query options), `use<X>.api.ts` (query hook with
    `meta.entities`), `<verb><X>.ts` (write returning a tagged union), `<x>Guards.ts` (route guards for
    `beforeLoad`).
  - `Ui/`: components and effect hooks. The public component sits at the root of `Ui/`.
- Imports flow `Ui → Api → Domain`. Between modules, only through `Shared/` or a module's public face
  (`Ui/*.tsx` at the root, `Api/use*.api.ts` at the root). Route files may also import `Api/<x>Guards.ts`.
- When a file grows, its private parts move into a **twin folder** with the same name (`Ui/LoginForm.tsx` +
  `Ui/LoginForm/`). Relative imports only into the own twin; everything else uses `@app/…`.
- Forbidden: barrels, `index.ts(x)` (outside routes), `types.ts`, `utils.ts`, `helpers.ts`, and folders named `types/`,
  `utils/`, `helpers/`, `__tests__/`. A file is named after what it contains.
- `Auth/` is the reference module: name the file you imitate before creating a new one.

## Code

- Named exports only (`export default` only in config files). `interface XProps` right above the component.
- No `any`, `@ts-ignore` or non-null `!`: use `unknown` and a guard. Derive types (`z.infer`, generated schema,
  `as const`); annotate the return type of exported functions.
- Writes never throw: they return `{ status: 'success', … } | { status: 'error', fieldErrors | formError }`. List
  fetchers throw `ApiError`; detail fetchers return `null` on 404. No `useMutation`.
- The URL is the state (page, filters, sort, open item) via validated search params; `useState` only for local UI.
- **Amounts are strings from the API: format them, never compute with them** (see money-and-exactness).
- Toasts only through `Shared/Ui/toast.ts`. Forms: react-hook-form + zod, schema in `Domain/`, server errors via
  `setError`. API error `code` is the translation key (exhaustive table); the server message is never displayed.

## UI

- Reuse order: `Shared/Ui` compositions → `@heroui/react` → a composition of both. Never a home-made primitive.
- Theme tokens only: no hex colors and no `dark:` variants in components. Icons from `lucide-react`.
- `onPress`, never `onClick`. Touch targets ≥ 44 px. Desktop sidebar ≥ 48rem, mobile tab bar below.

## i18n

- `` t`…` `` in components and hooks, `` msg`…` `` for module-level constants, `<Trans>` for JSX, `<Plural>` for counts.
- The English text is the key. Every visible string ships with its `fr` and `de` translations in the same commit; a
  missing translation fails the build.

## PWA

- The service worker never handles `/api/*` (so SSE never goes through it). A new version activates only after the user
  accepts the update prompt.
