# ContextRail

[中文](./README.md) | English

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
- Keeps an append-only history per live session while context observations update its active context set.
- Switches viewer tabs without switching, stopping, or mutating the agent session.
- Reconciles live graph nodes without rebuilding the canvas or resetting the camera.
- Reveals nodes from the same live context burst in order, while hydration and tab changes stay immediate.
- Coalesces queued state changes and transfers bounded deltas that the viewer applies atomically.
- Marks sessions from crashed or disconnected agent processes offline after their heartbeat expires while retaining history.
- Keeps active cards in the DOM and virtualizes historical cards and graph edges through a ticker-free Pixi/WebGL layer.
- Stops the browser render loop after camera, frame, node, and edge animations settle.
- Shows content previews on cards and opens a desktop nonmodal inspector or mobile full-screen reader for model-facing content exposed by the host context APIs.
- Retains a bounded archive of context observations for replay and comparison of adjacent captures.
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

- **Window** lays out the latest observed context, or a retained capture selected for replay, in captured message order from left to right and then top to bottom. The matrix grows progressively from two to six columns as space becomes available, avoiding sudden card shrinkage at a breakpoint. Historical cards keep their permanent homes; only cards that would overlap the frame move outward on their original center ray, continuing farther only when another card occupies the first target.
- **Overview** restores every card to its permanent home position and fits the complete spatial history. Compaction summaries open new epochs on a serpentine infinite canvas without moving earlier epochs.
- On desktop, selecting a card opens a nonmodal side inspector for its context state and allowlisted text, thinking, tool-call, or image blocks; the canvas remains interactive. Mobile uses a full-screen reader with keyboard focus contained in the panel. One source card can show multiple model messages when a host splits developer text from user image attachments.
- Dashed pending nodes sit just outside the Window frame until a host `context` event confirms that they were present at the context hook.
- Session tabs are read-only. Selecting one changes only the displayed timeline.
- **Follow active** is off by default, so background activity cannot move the selected tab. Enabling it tracks the most recently active session.
- Background sessions continue collecting events and show an activity marker without stealing focus.
- The viewer URL carries a tab-scoped read capability in its fragment. The page removes that fragment from the visible address as soon as it loads and reuses the capability when the tab reloads.
- Each session remembers its own camera and Window/Overview mode.
- Dragging the canvas pans, scrolling zooms, and dragging a node temporarily displaces it before it returns to its scene position. Clicking dim history travels to its epoch; left and right arrow keys move between epochs while canvas chrome is not focused.
- Active and pending cards remain DOM elements. Historical cards and edges use Pixi/WebGL with viewport culling, semantic zoom, an incremental hit grid, and a DOM/SVG fallback if WebGL is unavailable or loses its context.
- The usage rail, model, phase, tools, and compaction state update over Server-Sent Events.

### Reading content

Card previews use the first nonempty heading or text line. Tool calls show their name and a recognized path, command, or query argument; tool results show their name and the first actual output line. Separate badges identify multiple model messages, images, and errors. A synthetic compaction marker is distinct from a captured summary with actual text.

The inspector preserves model-message order and gives each message its own role header, including repeated roles. `Read` formats headings, paragraphs, and code blocks; `Original` shows captured block text. Thinking is collapsed by default, and images load on demand. Initial rendering is limited to 24 blocks, with long text paged in chunks of at most 16,000 characters per block. Load-more buttons expose the rest.

Copying content preserves role headers, text, thinking, and tool arguments, with image metadata markers instead of image data. Neither `Original` nor copied content is the original provider request JSON. The provenance section distinguishes the source role from model roles and explains the context-hook reconstruction boundary.

### Content search

Search supports Chinese text, multiple terms, case normalization, and Unicode whitespace, with up to 40 displayed results. It searches **bounded indexed excerpts, not full content**: at most 12,000 characters per item, 10,000 retained index entries, and 8 MiB of retained excerpt and normalized text. Image base64 is excluded; tool arguments contribute only recognized path, command, or query previews.

A missing result can mean the match lies beyond the indexed excerpt or the item was omitted from the index. It does not establish that the source content is absent. The 8 MiB figure is the retained-text budget, not a measurement of index objects, complete messages, canvas state, or total browser heap.

The index considers the newest 10,000 records and allocates its text budget newest-first; results remain chronological. At 750 or more items, construction yields between slices of at most 128 work items with a 6 ms target budget, then replaces the index atomically. Session or capture changes cancel obsolete work. Rebuilding displays a status instead of search results from the previous content. Atomic replacement may temporarily retain both old and staging indexes, each with up to 8 MiB of text; an individual work item cannot be interrupted by the time budget.

### Large-session background work and history retention

Scenes with at least 750 items compute geometry in a same-origin Web Worker. Only IDs, kinds, ordering, and connections are sent, never message bodies or images. The old scene remains visible with an update status and its card entry points temporarily disabled until the latest result commits. Obsolete work is cancelled; an unavailable Worker falls back to main-thread layout. JSON parsing, metadata preparation, and final canvas submission still run on the main thread, so initial display is not guaranteed to be free of long tasks.

Each runtime defaults to retaining at most 2,000 history items and 16 MiB of serialized UTF-8 JSON items and summary connections. Crossing either budget removes the oldest inactive records and incident connections, using incremental removals to update viewers. Active and pending items are always protected, even when they exceed the budget themselves; the UI explicitly reports that condition. The runtime API accepts `historyRetention: { maxItems, maxBytes }`; the `ContextTimeline` constructor accepts the same options.

Retention affects ContextRail's in-memory view only: it does not delete agent session files, compact model context, or write to disk. History, captures, and search have independent budgets, not a combined process-heap ceiling. Immutable items and content use structural sharing to avoid repeated deep copies; mutable external inputs are still copied at the boundary.

### Context captures and replay

Each session retains at most 24 captures by default, within an 8 MiB **serialized UTF-8 JSON** archive budget. Older captures are evicted when the count or byte budget is reached. This archive budget is separate from the browser's 8 MiB search-text budget, and neither is an overall process or browser heap limit. Captures stay in memory and are not written to disk.

While replaying, the browser additionally holds one selected archive so incoming captures or eviction cannot change the text being read. Returning to latest or switching sessions releases that replay reference; the live buffer continues normal count and byte eviction.

The capture selector can replay retained content and compare adjacent captures. Returning to the live view does not control or rewind the agent. A capture that exceeds the byte budget by itself retains an explicit content-unavailable marker; its content cannot be replayed, and content differences involving that capture are unavailable.

A capture records what ContextRail observed at a context hook or during session reconstruction. It is **not proof that a model call subsequently occurred**. Pi session restoration, tree navigation, and compaction reconstruction can also create records. Later extensions and provider transforms may still change the final request; ContextRail does not expose raw provider request payloads.

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
src/context-captures.ts bounded immutable archive of context observations

web/index.html             viewer shell, live session store, camera, DOM cards, and fallback
web/src/scene-layout.ts    permanent epochs, ordered focus matrix, and history projection
web/src/camera.ts          renderer-neutral screen/world coordinate transforms
web/src/pixi-history.ts    ticker-free historical card, edge, culling, and hit-test renderer
web/src/content-view.ts    cached content previews and bounded excerpt search
web/src/inspector-view.ts  paged nonmodal inspector rendering and copy text
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
- Capture identifiers represent observations, not evidence of model calls. Synthetic compaction markers are not model messages, and byte-limited captures do not provide content replay or content differences.
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
