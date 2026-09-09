import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	accessSync,
	closeSync,
	constants,
	existsSync,
	openSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chunkRenderStatePatch, diffRenderState } from "./hub-delta.ts";
import { streamIdFor, type ContextRailSessionSource } from "./hub-types.ts";
import {
	contextRailDiscoveryPath,
	ensurePrivateDiscoveryDirectory,
	healthyHubDiscovery,
} from "./hub-discovery.ts";
import type { RenderState } from "./render.ts";
import type { ContextRailViewer } from "./server.ts";
import { captureRenderStateForTransport } from "./immutable-state.ts";

export interface ConnectContextRailHubOptions {
	processId: string;
	startIfMissing?: boolean;
	timeoutMs?: number;
}

interface HubStartAttempt {
	child: ChildProcess;
	cliPath: string;
	executable: string;
	logPath: string;
	spawnError?: Error;
	exitCode?: number | null;
	exitSignal?: NodeJS.Signals | null;
}

const MIN_NODE_VERSION = [22, 6, 0] as const;
const MIN_NODE_VERSION_LABEL = MIN_NODE_VERSION.join(".");
const MAX_ACKNOWLEDGED_STREAMS = 100;
const PUBLISH_RETRY_BASE_MS = 250;
const PUBLISH_RETRY_MAX_MS = 2_000;

class HubVersionConflictError extends Error {
	readonly version: number;

	constructor(version: number) {
		super("ContextRail Hub stream version conflict");
		this.version = version;
	}
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function commandCandidates(command: string, pathValue: string | undefined): string[] {
	if (isAbsolute(command)) return [command];
	return (pathValue?.split(delimiter) ?? [])
		.filter((directory) => directory.length > 0)
		.map((directory) => join(directory, command));
}

interface NodeRuntimeInspection {
	compatible: boolean;
	detail: string;
}

function inspectNodeRuntime(path: string): NodeRuntimeInspection {
	if (!isExecutable(path)) return { compatible: false, detail: "not executable" };
	const result = spawnSync(path, ["--version"], {
		encoding: "utf8",
		maxBuffer: 16 * 1024,
		timeout: 2_000,
		windowsHide: true,
	});
	if (result.error) return { compatible: false, detail: result.error.message };
	const output = `${result.stdout ?? ""} ${result.stderr ?? ""}`.trim();
	if (result.status !== 0) {
		return {
			compatible: false,
			detail: `version check exited with code ${result.status}${output ? `: ${output}` : ""}`,
		};
	}
	const version = /v?(\d+)\.(\d+)\.(\d+)/.exec(output);
	if (!version?.[1] || !version[2] || !version[3]) {
		return { compatible: false, detail: output ? `unrecognized version: ${output}` : "no version output" };
	}
	const parsed = [version[1], version[2], version[3]].map((part) => Number.parseInt(part, 10));
	const compatible =
		parsed[0]! > MIN_NODE_VERSION[0] ||
		(parsed[0] === MIN_NODE_VERSION[0] &&
			(parsed[1]! > MIN_NODE_VERSION[1] ||
				(parsed[1] === MIN_NODE_VERSION[1] && parsed[2]! >= MIN_NODE_VERSION[2])));
	return {
		compatible,
		detail: version[0],
	};
}

export function resolveNodeExecutable(
	execPath = process.execPath,
	environment: NodeJS.ProcessEnv = process.env,
): string {
	const configured = environment.CONTEXT_RAIL_NODE;
	if (configured) {
		const candidates = commandCandidates(configured, environment.PATH);
		const resolved = candidates.find(isExecutable);
		if (!resolved) {
			throw new Error(
				`CONTEXT_RAIL_NODE is not executable: ${configured}; attempted runtimes: ${candidates.join(", ") || configured}`,
			);
		}
		const inspection = inspectNodeRuntime(resolved);
		if (inspection.compatible) return resolved;
		throw new Error(
			`CONTEXT_RAIL_NODE must be Node.js ${MIN_NODE_VERSION_LABEL} or newer: ${resolved} (${inspection.detail})`,
		);
	}

	const nodeCommand = process.platform === "win32" ? "node.exe" : "node";
	const candidates = [
		/^node(?:\.exe)?$/i.test(basename(execPath)) ? execPath : undefined,
		environment.NVM_BIN ? join(environment.NVM_BIN, "node") : undefined,
		...commandCandidates(nodeCommand, environment.PATH),
		...(process.platform === "darwin"
			? ["/opt/homebrew/bin/node", "/usr/local/bin/node"]
			: process.platform === "win32"
				? []
				: ["/usr/local/bin/node", "/usr/bin/node"]),
	];
	const attempted: string[] = [];
	const seen = new Set<string>();
	for (const candidate of candidates) {
		if (!candidate || seen.has(candidate)) continue;
		seen.add(candidate);
		const inspection = inspectNodeRuntime(candidate);
		attempted.push(`${candidate} (${inspection.detail})`);
		if (inspection.compatible) return candidate;
	}

	throw new Error(
		`Node.js ${MIN_NODE_VERSION_LABEL}+ was not found. Attempted runtimes: ${attempted.join("; ") || "none"}. Install Node.js or set CONTEXT_RAIL_NODE to its absolute path.`,
	);
}

export function resolveHubCliPath(moduleUrl = import.meta.url): string {
	const modulePath = fileURLToPath(moduleUrl);
	const moduleDirectory = dirname(modulePath);
	const names = modulePath.endsWith(".ts") ? ["hub-cli.ts", "hub-cli.js"] : ["hub-cli.js", "hub-cli.ts"];
	const candidates = names.map((name) => join(moduleDirectory, name));
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	throw new Error(
		`ContextRail Hub CLI was not found. module=${modulePath}; attempted CLI paths: ${candidates.join(", ")}`,
	);
}

async function startHubProcess(): Promise<HubStartAttempt> {
	const cliPath = resolveHubCliPath();
	let executable: string;
	try {
		executable = resolveNodeExecutable();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Hub runtime resolution failed. cli=${cliPath}; ${message}`);
	}
	const args = cliPath.endsWith(".ts") ? ["--experimental-strip-types", cliPath] : [cliPath];
	const logDirectory = dirname(contextRailDiscoveryPath());
	await ensurePrivateDiscoveryDirectory();
	const logPath = join(logDirectory, `hub-start-${process.pid}-${Date.now()}.log`);
	const log = openSync(logPath, "w", 0o600);
	let attempt: HubStartAttempt;
	let child: ReturnType<typeof spawn>;
	try {
		child = spawn(executable, args, {
			detached: true,
			stdio: ["ignore", log, log],
			env: process.env,
		});
	} catch (error) {
		closeSync(log);
		removeStartupLog(logPath);
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Hub spawn failed. node=${executable}; cli=${cliPath}; ${message}`);
	}
	closeSync(log);
	attempt = { child, cliPath, executable, logPath };
	child.once("error", (error) => {
		attempt.spawnError = error;
	});
	child.once("exit", (code, signal) => {
		attempt.exitCode = code;
		attempt.exitSignal = signal;
	});
	child.unref();
	return attempt;
}

function readStartupLog(path: string): string {
	try {
		return readFileSync(path, "utf8").trim().slice(-1_200);
	} catch {
		return "";
	}
}

function removeStartupLog(path: string): void {
	try {
		rmSync(path, { force: true });
	} catch {
		// A startup log is diagnostic only; cleanup must not break a healthy connection.
	}
}

function hubStartError(attempt: HubStartAttempt, timeoutMs: number): Error {
	const log = readStartupLog(attempt.logPath);
	const processResult = attempt.spawnError
		? `spawn failed: ${attempt.spawnError.message}`
		: attempt.exitCode !== undefined || attempt.exitSignal !== undefined
			? `exited before ready (${attempt.exitSignal ? `signal ${attempt.exitSignal}` : `code ${attempt.exitCode}`})`
			: `did not become ready within ${timeoutMs}ms`;
	const command = `node=${attempt.executable}; cli=${attempt.cliPath}`;
	return new Error(`Hub ${processResult}. ${command}${log ? `; ${log}` : ""}`);
}

async function waitForHub(
	timeoutMs: number,
	attempt?: HubStartAttempt,
): Promise<Awaited<ReturnType<typeof healthyHubDiscovery>>> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const discovery = await healthyHubDiscovery();
		if (discovery) {
			if (attempt) removeStartupLog(attempt.logPath);
			return discovery;
		}
		if (attempt?.spawnError || (attempt?.exitCode !== undefined && attempt.exitCode !== 0)) {
			const error = hubStartError(attempt, timeoutMs);
			removeStartupLog(attempt.logPath);
			throw error;
		}
		await new Promise((resolve) => setTimeout(resolve, 60));
	}
	if (attempt) {
		const error = hubStartError(attempt, timeoutMs);
		if (attempt.exitCode === undefined && attempt.exitSignal === undefined) {
			attempt.child.kill("SIGTERM");
		}
		removeStartupLog(attempt.logPath);
		throw error;
	}
	return undefined;
}

export async function connectContextRailHub(
	options: ConnectContextRailHubOptions,
): Promise<ContextRailViewer | undefined> {
	let discovery = await healthyHubDiscovery();
	if (!discovery && options.startIfMissing) {
		const timeoutMs = options.timeoutMs ?? 4_000;
		const attempt = await startHubProcess();
		discovery = await waitForHub(timeoutMs, attempt);
	}
	if (!discovery) return undefined;

	interface PendingState {
		state: RenderState;
		source: ContextRailSessionSource;
	}
	interface AcknowledgedStream {
		state?: RenderState;
		version: number;
	}

	const acknowledgedStreams = new Map<string, AcknowledgedStream>();
	const pending = new Map<string, PendingState>();
	let drainPromise: Promise<void> | undefined;
	let retryTimer: NodeJS.Timeout | undefined;
	let retryAttempt = 0;
	let controlChain = Promise.resolve();
	let publishFailure: Error | undefined;
	let controlFailure: Error | undefined;
	let stopping = false;
	let stopPromise: Promise<void> | undefined;

	const captureState = captureRenderStateForTransport;
	const acknowledgedStream = (streamId: string): AcknowledgedStream | undefined => {
		const acknowledged = acknowledgedStreams.get(streamId);
		if (!acknowledged) return undefined;
		acknowledgedStreams.delete(streamId);
		acknowledgedStreams.set(streamId, acknowledged);
		return acknowledged;
	};
	const setAcknowledgedStream = (streamId: string, acknowledged: AcknowledgedStream): void => {
		acknowledgedStreams.delete(streamId);
		acknowledgedStreams.set(streamId, acknowledged);
		while (acknowledgedStreams.size > MAX_ACKNOWLEDGED_STREAMS) {
			const oldest = acknowledgedStreams.keys().next().value as string | undefined;
			if (!oldest) return;
			acknowledgedStreams.delete(oldest);
		}
	};

	const post = async (path: string, body: unknown): Promise<{ version?: number }> => {
		const response = await fetch(`${discovery.url}api/${path}`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${discovery.token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(2_000),
		});
		const text = await response.text();
		let payload: unknown;
		if (text) {
			try {
				payload = JSON.parse(text) as unknown;
			} catch {
				payload = undefined;
			}
		}
		if (
			response.status === 409 &&
			payload &&
			typeof payload === "object" &&
			"error" in payload &&
			payload.error === "version_conflict" &&
			"version" in payload &&
			typeof payload.version === "number" &&
			Number.isSafeInteger(payload.version) &&
			payload.version >= 0
		) {
			throw new HubVersionConflictError(payload.version);
		}
		if (!response.ok) throw new Error(`ContextRail Hub returned ${response.status}`);
		if (
			payload &&
			typeof payload === "object" &&
			"version" in payload &&
			typeof payload.version === "number" &&
			Number.isSafeInteger(payload.version) &&
			payload.version >= 0
		) {
			return { version: payload.version };
		}
		return {};
	};

	const publishQueuedState = async (streamId: string, queued: PendingState): Promise<void> => {
		// Enqueue already captured an immutable, defensive handoff. Cloning it
		// again here would copy every retained live detail a second time.
		const target = queued.state;
		for (let attempt = 0; attempt < 4; attempt += 1) {
			const acknowledged = acknowledgedStream(streamId);
			const baseVersion = acknowledged?.version ?? 0;
			const patch = diffRenderState(acknowledged?.state, target);
			const transferId = randomUUID();
			try {
				let publishedVersion: number | undefined;
				for (const chunk of chunkRenderStatePatch(patch)) {
					const result = await post("publish-delta", {
						source: queued.source,
						transferId,
						baseVersion,
						...chunk,
					});
					if (result.version !== undefined) publishedVersion = result.version;
				}
				setAcknowledgedStream(streamId, {
					state: target,
					version: publishedVersion ?? baseVersion + 1,
				});
				return;
			} catch (error) {
				if (!(error instanceof HubVersionConflictError) || attempt === 3) throw error;
				setAcknowledgedStream(streamId, { version: error.version });
			}
		}
	};

	const drain = async (): Promise<void> => {
		while (pending.size > 0) {
			const entry = pending.entries().next().value as [string, PendingState] | undefined;
			if (!entry) return;
			const [streamId, queued] = entry;
			pending.delete(streamId);
			try {
				await publishQueuedState(streamId, queued);
			} catch (error) {
				// A newer state wins; otherwise retain the failed state for an idle retry.
				if (!stopping && !pending.has(streamId)) pending.set(streamId, queued);
				throw error;
			}
		}
	};

	const scheduleRetry = (): void => {
		if (retryTimer || stopping || pending.size === 0) return;
		const delay = Math.min(PUBLISH_RETRY_BASE_MS * 2 ** retryAttempt, PUBLISH_RETRY_MAX_MS);
		retryAttempt += 1;
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			scheduleDrain();
		}, delay);
		retryTimer.unref();
	};

	const scheduleDrain = (): void => {
		if (drainPromise || retryTimer || stopping) return;
		drainPromise = drain()
			.then(() => {
				publishFailure = undefined;
				retryAttempt = 0;
			})
			.catch((error: unknown) => {
				publishFailure = error instanceof Error ? error : new Error(String(error));
			})
			.finally(() => {
				drainPromise = undefined;
				if (pending.size === 0) return;
				if (publishFailure) scheduleRetry();
				else scheduleDrain();
			});
	};

	const sendControl = (path: string, body: unknown): void => {
		if (stopping) return;
		controlChain = controlChain.then(async () => {
			try {
				await post(path, body);
				controlFailure = undefined;
			} catch (error) {
				controlFailure = error instanceof Error ? error : new Error(String(error));
			}
		});
	};

	return {
		instanceId: discovery.instanceId,
		port: discovery.port,
		url: discovery.url,
		viewerUrl: `${discovery.url}#token=${encodeURIComponent(discovery.viewerToken)}`,
		async healthy() {
			if (stopping || publishFailure || controlFailure) return false;
			return Boolean(await healthyHubDiscovery(discovery));
		},
		publish(state: RenderState, source?: ContextRailSessionSource) {
			if (!source || stopping) return;
			pending.set(streamIdFor(source), { state: captureState(state), source: { ...source } });
			scheduleDrain();
		},
		heartbeat(processId: string) {
			sendControl("heartbeat", { processId });
		},
		disconnect(processId: string) {
			sendControl("disconnect", { processId });
		},
		dispose() {
			if (stopping) return;
			stopping = true;
			if (retryTimer) {
				clearTimeout(retryTimer);
				retryTimer = undefined;
			}
			pending.clear();
		},
		async stop() {
			if (stopPromise) return stopPromise;
			stopping = true;
			if (retryTimer) {
				clearTimeout(retryTimer);
				retryTimer = undefined;
			}
			stopPromise = (async () => {
				await drainPromise;
				pending.clear();
				await controlChain;
				try {
					await post("disconnect", { processId: options.processId });
				} catch {
					// Disconnect is best effort during process shutdown.
				}
			})();
			return stopPromise;
		},
	};
}
