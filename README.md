# Unwater

A cross-platform (Windows + macOS) **open-source** desktop app that removes watermarks and
unwanted regions from **images, GIFs, and videos** using **local AI inpainting**.

- **100% local & private.** No API keys, no cloud, no telemetry. No file ever leaves your machine.
- **Offline** after the one-time model download.
- **Runs for everyone:** works CPU-only and scales up on GPU/Apple Silicon.

> **Status:** Phase 0 (scaffold). See `IMPLEMENTATION_PLAN.md` for the full roadmap.

## Legitimate-use notice

Unwater is intended for removing **your own** watermarks, cleaning up footage you have the
rights to, and restoring images you are permitted to edit. **You are responsible for
respecting copyright and the rights of others.** Do not use this tool to remove watermarks
or attribution from content you do not own or have permission to modify.

## Development

```bash
npm install      # install dependencies
npm run dev      # launch the app in development
npm run build    # typecheck + bundle
npm test         # run unit tests (Vitest)
npm run lint     # ESLint
```

## License

App code is MIT (see `LICENSE`). Bundled models and libraries retain their own permissive
licenses, tracked in `THIRD_PARTY_LICENSES.md`.
