# ContextRail

See what your agent actually remembers. ContextRail is a read-only extension for [Oh My Pi](https://github.com/can1357/oh-my-pi) and [Pi](https://github.com/earendil-works/pi) that makes the agent's active context visible in the terminal and in a live local web viewer.

The extension observes each host's public lifecycle events, renders a compact terminal strip, and streams an explicit allowlist of model-context details to an interactive local graph viewer without changing the messages sent to the model.

## Current behavior

- Shows total context usage in the host's status area.
- Classifies active context entries as system, memory, developer, user, assistant, or tool.
- Shows tool execution and compaction phases.
- Provides `/context-rail` with `show`, `hide`, and `toggle` actions.
- Starts or joins a localhost-only Hub and HTML viewer with `/context-rail web`.
- Collects multiple OMP and Pi processes and sessions in one viewer.
- Adds history nodes from finalized user, assistant, and tool-result events as they happen.
- Uses each pre-call `context` event as the authoritative active-window track and confirms matching pending nodes in place.
- Reconciles Pi session start, compaction, and tree navigation immediately from Pi's read-only active context entries.
- Keeps an append-only history per live session while each model call updates its active context set.
- Switches viewer tabs without switching, stopping, or mutating the agent session.
- Reconciles live graph nodes without rebuilding the canvas or resetting the camera.
- Reveals nodes from the same live context burst in order, while hydration and tab changes stay immediate.
- Coalesces queued state changes and transfers bounded deltas that the viewer applies atomically.
- Marks sessions from crashed or disconnected agent processes offline after their heartbeat expires while retaining history.
- Keeps active cards in the DOM and virtualizes historical cards and graph edges through a ticker-free Pixi/WebGL layer.
- Stops the browser render loop after camera, frame, node, and edge animations settle.
- Opens each card into an in-memory detail drawer with the model-facing content exposed by the host context APIs.
- Does not write message details or transcripts to disk.

The first version treats each message as one visual block. It does not claim that block width is an exact per-message token measurement.

## Requirements

- OMP 17.1.3 or newer, and/or Pi 0.83.0 or newer
- Node.js 22.6.0 or newer for OMP, the shared web Hub, and development
- Node.js 22.19.0 or newer when running Pi 0.83.0

## Install for OMP

```sh
omp plugin install github:izumi0uu/context-rail
omp plugin enable context-rail
omp
```

Restart any OMP process that was already running so it loads the extension.

## Install for Pi

From a source checkout:

```sh
npm install
pi install "$PWD"
pi
```

`pi install` records the local package path in Pi's user settings. Restart Pi after rebuilding ContextRail so the compiled extension is reloaded. For a one-off source run without installing the package:

```sh
npm install
pi --extension ./src/pi.ts
```

## Link a source checkout

```sh
npm install
omp plugin link .
omp plugin enable context-rail
omp
```

`npm install` also builds the `dist/` files used by both extensions and the Hub CLI. For a one-off OMP source run without linking the package:

```sh
npm install
omp --extension ./src/index.ts
```

Inside OMP or Pi:

```text
/context-rail show
/context-rail hide
/context-rail toggle
/context-rail web
/context-rail stop
```

`web` starts the shared Hub when needed and prints its local viewer URL. Use this command to obtain the viewer entry URL; the Hub daemon does not write its viewer capability to startup logs. Other linked OMP or Pi processes join that Hub when they next emit an event. `stop` disconnects only the current agent process; it does not affect other agents. The compact terminal status remains visible while the expanded strip is hidden.

The Hub runs independently from either host so one agent process can exit without taking down the viewer. For a GitHub-installed plugin, stop the shared Hub with:

```sh
npm exec --yes --package=github:izumi0uu/context-rail -- context-rail stop
```

For a linked source checkout, run `npm run hub -- stop` from that checkout. Both commands wait until the old Hub has released its discovery file and lock, so starting it again immediately is safe.

If OMP was launched from an environment that cannot find Node.js, ContextRail reports the resolved runtime and Hub CLI paths in the startup error. You can select Node explicitly before starting OMP:

```sh
export CONTEXT_RAIL_NODE=/absolute/path/to/node
omp
```

## Web viewer

The viewer keeps the full-screen camera, pan, cursor-anchored zoom, floating-node, and spatial scene behavior of [graphcon-deck](https://github.com/yoheinakajima/graphcon-deck), adapted to reconcile a changing context instead of advancing through authored slides.

- **Window** projects the items in the current model call around a central hub inside a rectangular frame. Historical cards keep their permanent homes; only cards that would overlap the frame move outward on their original center ray, continuing farther only when another card occupies the first target.
- **Overview** restores every card to its permanent home position and fits the complete spatial history. Compaction summaries open new epochs on a serpentine infinite canvas without moving earlier epochs.
- Selecting a card opens its model role(s), context state, and allowlisted text, thinking, tool-call, or image blocks. One source card can show multiple model messages when a host splits developer text from user image attachments.
- Dashed pending nodes sit just outside the Window frame until a real host `context` event confirms that the model received them.
- Session tabs are read-only. Selecting one changes only the displayed timeline.
- **Follow active** is off by default, so background activity cannot move the selected tab. Enabling it tracks the most recently active session.
- Background sessions continue collecting events and show an activity marker without stealing focus.
- The viewer URL carries a tab-scoped read capability in its fragment. The page removes that fragment from the visible address as soon as it loads and reuses the capability when the tab reloads.
- Each session remembers its own camera and Window/Overview mode.
- Dragging the canvas pans, scrolling zooms, and dragging a node temporarily displaces it before it returns to its scene position. Clicking dim history travels to its epoch; left and right arrow keys move between epochs while canvas chrome is not focused.
- Active and pending cards remain DOM elements. Historical cards and edges use Pixi/WebGL with viewport culling, semantic zoom, an incremental hit grid, and a DOM/SVG fallback if WebGL is unavailable or loses its context.
- The usage rail, model, phase, tools, and compaction state update over Server-Sent Events.

For a standalone demo:

```sh
npm run preview
```

Open the printed URL. The preview publishes generated snapshots over the real SSE path and periodically simulates compaction; it does not require OMP to be running.

## Architecture

```text
OMP process A -----+
OMP process B -----+--> local ContextRail Hub --> HTTP/SSE --> web/index.html
Pi process A ------+          |
Pi process B ------+          +--> per-process/session read models

src/extension-runtime.ts  provider-neutral session/runtime and Hub publisher
src/omp-extension.ts      read-only OMP lifecycle adapter
src/pi-extension.ts       read-only Pi lifecycle adapter
src/index.ts              backward-compatible OMP package entry
src/pi.ts                 Pi package entry
src/hub-client.ts     authenticated, non-blocking Hub publisher
src/hub-delta.ts      state diff, bounded transport chunks, and reconstruction
src/hub-cli.ts        independent Hub lifecycle
src/server.ts         localhost ingest API + SSE viewer server

src/snapshot.ts    shared normalized context model
src/timeline.ts    observed history, authoritative active set, and reconciliation diffs

web/index.html             viewer shell, live session store, camera, DOM cards, and fallback
web/src/scene-layout.ts    permanent epochs, four-sided focus layout, and history projection
web/src/camera.ts          renderer-neutral screen/world coordinate transforms
web/src/pixi-history.ts    ticker-free historical card, edge, culling, and hit-test renderer
```

Keeping the snapshot model and runtime independent from either host lets OMP and Pi share one Hub, timeline model, and viewer without duplicating behavior.

## Development

```sh
npm test
npm run typecheck
npm run build
npm run check
```

Tests use Node's built-in test runner. The package compiles separate OMP and Pi entries to `dist/`, while both hosts can load their source entry directly during development.

OMP and Pi are runtime hosts rather than package dependencies. Each adapter uses a small structural type boundary, which keeps installs lightweight and prevents either host from becoming a dependency of the other.

## Safety boundaries

- The `context` handlers return nothing, so they cannot replace either host's message list.
- Card details reflect the agent-level messages observed at the host `context` hook or reconstructed from Pi's active context entries. Later extensions, provider serialization, tokenization, caching, or safety transforms can still change the final provider request.
- Pi compaction provenance is applied only after Pi emits `session_compact`; a cancelled or failed `session_before_compact` cannot create a false summary boundary.
- The event track emits opaque, session-local node IDs plus an explicit allowlist of model-facing text, thinking, tool-call arguments, images, roles, and tool names; token-level `message_update` events are intentionally ignored.
- Raw host message IDs, tool-call IDs, and timestamps are used only as in-process matching anchors and are never sent to the Hub.
- Provider signatures, response IDs, usage records, diagnostics, and extension-private `details` fields are not sent to the Hub.
- Message details live only in the host process, Hub memory, and the open browser page. The Hub retains disconnected session state for up to one hour unless it is stopped sooner.
- The Hub binds to a random `127.0.0.1` port and rejects cross-origin reads.
- Producer requests and the viewer event stream use separate random write and read capabilities stored in a user-private temporary discovery file.
- The viewer URL contains only the read capability. It is not injected into the served HTML or Hub daemon logs, and cannot publish, heartbeat, or disconnect a producer. Anyone with this URL can read the in-memory card details while the Hub is running.
- The Hub projects direct publishes and decoded deltas onto a strict allowlisted wire schema before retaining or streaming them.
- The server sends no CORS headers and applies a restrictive Content Security Policy.
- The viewer has no endpoint that can switch sessions, send prompts, abort work, or stop an agent.
- Streaming token events are deliberately excluded from the initial version to avoid repainting the TUI for every token.
- Overall usage is reported by the host. Per-message token accounting is not estimated yet.

## Roadmap

- Add optional durable Hub history across machine restarts.
- Mark pinned context with richer provenance.
- Add configurable in-memory history retention for very long-running sessions.
- Add optional per-item token weights when OMP exposes reliable measurements.
- Add adapter compatibility fixtures for future OMP and Pi lifecycle revisions.

## License

MIT
