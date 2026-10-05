# Repository Guidelines

## Project Structure & Module Organization

NetNexus is a Vue 3/Electron network toolkit.

- `src/`: renderer views, components, router, Vuex store, and UI assets.
- `electron/`: main process, preload APIs, application controllers, protocol workers, parsers, and utilities.
- `shared/`: protocol definitions shared across processes.
- `test/ci/`, `test/e2e/`, `test/integration/`: regression scripts, Playwright tests, and FRR interoperability tests.
- `scripts/`: native builds, packaging, mocks, and benchmarks; `resources/`: bundled native runtimes.
- `docs/`: VitePress documentation and screenshots; `electron/assets/`: packaging assets. Generated builds go to `dist/` and `release/`.

## Build, Test, and Development Commands

Use Node.js `16.20.2`, matching application CI. Preserve the documented Electron 22 compatibility policy in `docs/DEVELOPMENT.md`.

- `npm ci`: install locked dependencies and rebuild native runtimes; requires Python and a C/C++ toolchain, plus CMake for libyang.
- `npm run dev`: start Vite and Electron, checking native helpers first.
- `npm run build`: build renderer production assets.
- `npm run lint`: check JavaScript and Vue files in `src/` and `electron/`.
- `npm run dist:linux:x64`: build a `.deb` on a native Ubuntu x64 host; use the arm64 variant on arm64.
- `npm run docs:build`: build documentation using its isolated dependencies and runtime.

## Coding Style & Naming Conventions

Follow `.editorconfig`, `.prettierrc`, and `.eslintrc.js`: four spaces, LF, 120-column formatting, semicolons, single quotes, and no trailing commas. Use ES modules in `src/`, CommonJS in `electron/`, and Vue Composition API. Name Vue components in PascalCase and JavaScript modules/functions in camelCase. Format changed files with `npx prettier --write <paths>`; `npm run format` formats the entire repository.

## Testing Guidelines

`npm test` runs standalone assertion scripts through Electron, including utility-process tests. Name regressions `test/ci/<feature_name>.js`. Playwright specs use `test/e2e/<feature-name>.spec.js`; run `npm run test:e2e` for packaged Electron or `npm run test:e2e:browser` for browser mode. Docker is required for `npm run test:e2e:frr`. No numeric coverage threshold is configured; cover changed behavior and relevant failure paths.

## Commit & Pull Request Guidelines

Follow the predominant history convention: `type(scope): subject`, such as `fix(bmp): refresh committed routes`; scope is optional. Use `.github/PULL_REQUEST_TEMPLATE.md`: describe behavior changes, reference issues, report validation and OS/Node/Electron versions, update affected documentation, and attach screenshots for UI changes. Keep commits focused and preserve unrelated working-tree changes.
