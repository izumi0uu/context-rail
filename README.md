# ContextRail

See what your agent actually remembers. ContextRail is a read-only [Oh My Pi](https://github.com/can1357/oh-my-pi) extension that makes the agent's active context visible in the terminal.

This repository is an intentionally small foundation. The extension observes OMP's public lifecycle events, renders a compact status line, and can expand into a context strip without changing the messages sent to the model.

## Current behavior

- Shows total context usage in OMP's status area.
- Classifies active context entries as system, memory, user, assistant, or tool.
- Shows tool execution and compaction phases.
- Provides `/context-rail` with `show`, `hide`, and `toggle` actions.
- Keeps message content in memory and never writes transcripts to disk.

The first version treats each message as one visual block. It does not claim that block width is an exact per-message token measurement.

## Requirements

- OMP 17.1.3 or newer
- Node.js 22 or newer for development

## Try it locally

```sh
npm install
omp plugin link .
omp
```

For a one-off run without linking the package:

```sh
omp --extension ./src/index.ts
```

Inside OMP:

```text
/context-rail show
/context-rail hide
/context-rail toggle
```

The compact status remains visible while the expanded strip is hidden.

## Architecture

```text
OMP lifecycle events
        |
        v
src/index.ts       read-only OMP adapter
        |
        v
src/snapshot.ts    normalized context snapshot
        |
        v
src/render.ts      terminal-safe status and detail lines
```

Keeping the snapshot model independent from OMP makes a future Pi adapter or web viewer possible without rewriting the UI model.

## Development

```sh
npm test
npm run typecheck
npm run build
npm run check
```

Tests use Node's built-in test runner. The package compiles to `dist/`, while OMP can load `src/index.ts` directly during development.

OMP is the runtime host rather than a package dependency. The extension uses a small structural type boundary in `src/omp-types.ts`, which keeps local installs lightweight while making the OMP-facing surface explicit and reviewable.

## Safety boundaries

- The `context` handler returns nothing, so it cannot replace OMP's message list.
- Full message text and tool output are not rendered or persisted.
- Streaming token events are deliberately excluded from the initial version to avoid repainting the TUI for every token.
- Overall usage is reported by OMP. Per-message token accounting is not estimated yet.

## Roadmap

- Mark summaries and pinned context with richer provenance.
- Add throttled streaming state.
- Export the same normalized snapshots to an optional local web viewer.
- Add a Pi adapter behind the existing snapshot interface.

## License

MIT
