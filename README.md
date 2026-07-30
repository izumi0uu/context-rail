# ContextRail

See what your agent actually remembers. ContextRail is a read-only [Oh My Pi](https://github.com/can1357/oh-my-pi) extension that makes the agent's active context visible in the terminal and in a live local web viewer.

The extension observes OMP's public lifecycle events, renders a compact terminal strip, and streams content-free snapshots to an interactive graph viewer without changing the messages sent to the model.

## Current behavior

- Shows total context usage in OMP's status area.
- Classifies active context entries as system, memory, user, assistant, or tool.
- Shows tool execution and compaction phases.
- Provides `/context-rail` with `show`, `hide`, and `toggle` actions.
- Starts a localhost-only HTML viewer with `/context-rail web`.
- Keeps an append-only session history while each model call updates the active context set.
- Reconciles live graph nodes without rebuilding the canvas or resetting the camera.
- Does not retain message content or write transcripts to disk.

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
/context-rail web
/context-rail stop
```

`web` prints the local viewer URL. `stop` closes its HTTP/SSE server. The compact terminal status remains visible while the expanded strip is hidden.

## Web viewer

The viewer keeps the full-screen camera, pan, zoom, floating-node, and SVG edge behavior of [graphcon-deck](https://github.com/yoheinakajima/graphcon-deck), adapted to reconcile a changing context instead of advancing through authored slides.

- **Window** projects the items in the current model call into a compact frame; inactive history remains on the canvas.
- **Overview** fits the complete session history and dims items outside the current model context.
- Dragging the canvas pans, scrolling zooms, and dragging a node temporarily pulls it out of the rail.
- The usage rail, model, phase, tools, and compaction state update over Server-Sent Events.

For a standalone demo:

```sh
npm run preview
```

Open the printed URL. The preview publishes generated snapshots over the real SSE path and periodically simulates compaction; it does not require OMP to be running.

## Architecture

```text
OMP lifecycle events
        |
        v
src/index.ts       read-only OMP adapter
        +--> src/render.ts      terminal-safe status and detail lines
        |
        +--> src/server.ts      localhost HTTP + SSE
                    |
                    v
              web/index.html   live history + active-window viewer

src/snapshot.ts    shared normalized context model
src/timeline.ts    append-only history and active-set diffs
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
- Full message text and tool output are not rendered, streamed, or persisted.
- The viewer binds to a random `127.0.0.1` port and rejects cross-origin reads.
- The server sends no CORS headers and applies a restrictive Content Security Policy.
- Streaming token events are deliberately excluded from the initial version to avoid repainting the TUI for every token.
- Overall usage is reported by OMP. Per-message token accounting is not estimated yet.

## Roadmap

- Mark pinned context with richer provenance.
- Add throttled streaming state.
- Add optional per-item token weights when OMP exposes reliable measurements.
- Add a Pi adapter behind the existing snapshot interface.

## License

MIT
