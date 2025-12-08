# AGENTS.md

## Build & Run Commands

- `pnpm install` - install dependencies (requires watchman)
- `pnpm build` - compile TypeScript to dist/
- `pnpm build:check` - type-check without emitting files
- `make dev ARGS="start --watch"` - run directly with tsx (no build needed)
- `make pre-commit` - run eslint --fix and prettier on all files

## Code Style

- **Formatting**: Prettier with single quotes, semicolons, 2-space indent, 100 char line width
- **Imports**: ESM with `.js` extension (e.g., `import { foo } from './bar.js'`)
- **Types**: Strict TypeScript, no `any` allowed, prefix unused params with `_`
- **Naming**: camelCase for functions/variables, PascalCase for types/interfaces
- **Docs**: JSDoc comments with `/** */` for exported functions
- **Exports**: Named exports preferred; re-export from index.ts barrel files

## Error Handling

- Use winston logger (`import { logger } from './logger.js'`)
- Errors should be logged with `logger.error()` before throwing or returning

## Project Structure

- `src/cli/` - CLI command handlers
- `src/api/` - Proton Drive API wrappers
- `src/db/` - Database schema and migrations (Drizzle ORM + SQLite)
