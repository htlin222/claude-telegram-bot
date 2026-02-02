# API Documentation

This project ships generated API docs from TypeDoc.

## Generate locally

```bash
bun run docs
```

Outputs:

- `docs/html/` — HTML API docs (GitHub Pages)
- `docs/markdown/` — Markdown API docs (TypeDoc Markdown plugin)

## Notes

- The docs are generated from `src/**/*.ts` (tests excluded).
- Provider switching clears the current session, so docs reflect runtime state.
