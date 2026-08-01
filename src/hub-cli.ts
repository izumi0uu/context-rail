#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import {
	contextRailLockPath,
	ensurePrivateDiscoveryDirectory,
	healthyHubDiscovery,
	readHubDiscovery,
	removeHubDiscovery,
	writeHubDiscovery,
} from "./hub-discovery.ts";
import type { ContextRailHubDiscovery } from "./hub-types.ts";
import { startContextRailServer } from "./server.ts";

const STOP_TIMEOUT_MS = 5_000;
const STOP_POLL_INTERVAL_MS = 50;
const LOCK_LEASE_TIMEOUT_MS = 10_000;
const LOCK_HEARTBEAT_INTERVAL_MS = 2_000;
const MAX_LOCK_ACQUIRE_ATTEMPTS = 4;

interface LockLease {
	version: 1;
	ownerId: string;
	pid: number;
}

interface LockSnapshot {
	contents: string;
	dev: number;
	ino: number;
	legacyPid?: number;
	lease?: LockLease;
	mtimeMs: number;
}

interface HeldLock {
	handle: Awaited<ReturnType<typeof open>>;
	heartbeat: NodeJS.Timeout;
	lease: LockLease;
}

interface RemoveLockOptions {
	requireStale?: boolean;
}

const TEST_LOCK_REMOVAL_READY = "context-rail:test:lock-removal-ready";
const TEST_LOCK_REMOVAL_CONTINUE = "context-rail:test:lock-removal-continue";

function errorCode(error: unknown): unknown {
	return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

function processIsRunning(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return errorCode(error) !== "ESRCH";
	}
}

function parseLockLease(contents: string): LockLease | undefined {
	try {
		const parsed = JSON.parse(contents) as Partial<LockLease>;
		if (
			parsed.version !== 1 ||
			typeof parsed.ownerId !== "string" ||
			parsed.ownerId.length === 0 ||
			typeof parsed.pid !== "number" ||
			!Number.isSafeInteger(parsed.pid) ||
			parsed.pid <= 0 ||
			parsed.pid > 0x7fffffff
		) {
			return undefined;
		}
		return parsed as LockLease;
	} catch {
		return undefined;
	}
}

function parseLegacyLockPid(contents: string): number | undefined {
	const trimmed = contents.trim();
	if (!/^[1-9]\d*$/.test(trimmed)) return undefined;
	const pid = Number(trimmed);
	return Number.isSafeInteger(pid) && pid <= 0x7fffffff ? pid : undefined;
}

async function readLockSnapshot(): Promise<LockSnapshot | undefined> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(contextRailLockPath(), "r");
		const [contents, lockStat] = await Promise.all([handle.readFile("utf8"), handle.stat()]);
		const lease = parseLockLease(contents);
		const legacyPid = lease ? undefined : parseLegacyLockPid(contents);
		return {
			contents,
			dev: lockStat.dev,
			ino: lockStat.ino,
			...(legacyPid ? { legacyPid } : {}),
			...(lease ? { lease } : {}),
			mtimeMs: lockStat.mtimeMs,
		};
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	} finally {
		await handle?.close();
	}
}

function leaseIsFresh(lock: LockSnapshot): boolean {
	return Date.now() - lock.mtimeMs < LOCK_LEASE_TIMEOUT_MS;
}

function lockBelongsTo(lock: LockSnapshot | undefined, ownerId: string): boolean {
	return lock?.lease?.ownerId === ownerId;
}

function lockBelongsToHub(
	lock: LockSnapshot | undefined,
	running: ContextRailHubDiscovery,
): boolean {
	return lockBelongsTo(lock, running.instanceId) || lock?.legacyPid === running.pid;
}

function sameLockSnapshot(left: LockSnapshot, right: LockSnapshot): boolean {
	return (
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.contents === right.contents &&
		left.mtimeMs === right.mtimeMs
	);
}

async function pauseLockRemovalForTest(): Promise<void> {
	if (
		process.env.NODE_ENV !== "test" ||
		process.env.CONTEXT_RAIL_TEST_LOCK_REMOVAL_BARRIER !== "1" ||
		!process.send
	) {
		return;
	}
	await new Promise<void>((resolve) => {
		const onMessage = (message: unknown): void => {
			if (message !== TEST_LOCK_REMOVAL_CONTINUE) return;
			process.off("message", onMessage);
			resolve();
		};
		process.on("message", onMessage);
		process.send?.(TEST_LOCK_REMOVAL_READY);
	});
}

async function removeLockIfUnchanged(
	expected: LockSnapshot,
	options: RemoveLockOptions = {},
): Promise<boolean> {
	const current = await readLockSnapshot();
	if (!current) return true;
	if (!sameLockSnapshot(current, expected)) return false;
	if (options.requireStale && leaseIsFresh(current)) return false;

	await pauseLockRemovalForTest();
	const latest = await readLockSnapshot();
	if (!latest) return true;
	if (!sameLockSnapshot(latest, current)) return false;
	if (options.requireStale && leaseIsFresh(latest)) return false;

	// Node has no inode-conditional unlink, so a non-cooperating path replacement
	// can still race this final revalidation. Every caller must honor false.
	await rm(contextRailLockPath(), { force: true });
	return true;
}

async function waitForHubStop(
	running: ContextRailHubDiscovery,
	timeoutMs = STOP_TIMEOUT_MS,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const [healthy, discovery, lock] = await Promise.all([
			healthyHubDiscovery(running),
			readHubDiscovery(),
			readLockSnapshot(),
		]);
		const oldOwnerProcessIsRunning = processIsRunning(running.pid);
		const oldOwnerIsActive =
			lock !== undefined &&
			lockBelongsToHub(lock, running) &&
			leaseIsFresh(lock) &&
			oldOwnerProcessIsRunning;
		if (!healthy && !oldOwnerIsActive) {
			if (discovery?.instanceId === running.instanceId) {
				await removeHubDiscovery(running.instanceId);
			}
			if (lock && lockBelongsToHub(lock, running)) {
				await removeLockIfUnchanged(lock, {
					requireStale: oldOwnerProcessIsRunning,
				});
			}

			const [remainingDiscovery, remainingLock] = await Promise.all([
				readHubDiscovery(),
				readLockSnapshot(),
			]);
			if (
				remainingDiscovery?.instanceId !== running.instanceId &&
				!lockBelongsToHub(remainingLock, running)
			) {
				return;
			}
		}
		await delay(STOP_POLL_INTERVAL_MS);
	}
	throw new Error(`ContextRail Hub ${running.pid} did not stop within ${timeoutMs}ms`);
}

if (process.argv[2] === "stop") {
	const running = await healthyHubDiscovery();
	if (!running) {
		console.log("ContextRail Hub is not running");
		process.exit(0);
	}
	try {
		process.kill(running.pid, "SIGTERM");
	} catch (error) {
		if (errorCode(error) !== "ESRCH") throw error;
	}
	await waitForHubStop(running);
	console.log("ContextRail Hub stopped");
	process.exit(0);
}

function startLockHeartbeat(handle: Awaited<ReturnType<typeof open>>): NodeJS.Timeout {
	const heartbeat = setInterval(() => {
		const now = new Date();
		void handle.utimes(now, now).catch(() => undefined);
	}, LOCK_HEARTBEAT_INTERVAL_MS);
	heartbeat.unref();
	return heartbeat;
}

async function acquireLock(ownerId: string): Promise<HeldLock | undefined> {
	const path = contextRailLockPath();
	const lease: LockLease = { version: 1, ownerId, pid: process.pid };
	await ensurePrivateDiscoveryDirectory();
	for (let attempt = 0; attempt < MAX_LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
		try {
			const handle = await open(path, "wx", 0o600);
			try {
				await handle.writeFile(JSON.stringify(lease));
				return { handle, heartbeat: startLockHeartbeat(handle), lease };
			} catch (error) {
				await handle.close();
				await rm(path, { force: true });
				throw error;
			}
		} catch (error) {
			const code = errorCode(error);
			if (code !== "EEXIST") throw error;
		}

		if (await healthyHubDiscovery()) return undefined;
		const existing = await readLockSnapshot();
		if (!existing) continue;
		const ownerPid = existing.lease?.pid ?? existing.legacyPid;
		if (ownerPid !== undefined && !processIsRunning(ownerPid)) {
			await removeLockIfUnchanged(existing);
			continue;
		}
		if (leaseIsFresh(existing)) return undefined;
		await removeLockIfUnchanged(existing, { requireStale: true });
	}
	return undefined;
}

async function releaseLock(lock: HeldLock): Promise<void> {
	clearInterval(lock.heartbeat);
	await lock.handle.close();
	const current = await readLockSnapshot();
	if (
		current?.lease?.ownerId === lock.lease.ownerId &&
		current.lease.pid === lock.lease.pid
	) {
		await removeLockIfUnchanged(current);
	}
}

const instanceId = randomUUID();
const lock = await acquireLock(instanceId);
if (!lock) process.exit(0);

const token = randomBytes(32).toString("base64url");
const viewerToken = randomBytes(32).toString("base64url");
let viewer: Awaited<ReturnType<typeof startContextRailServer>> | undefined;
const cleanup = async (): Promise<void> => {
	try {
		await viewer?.stop();
	} finally {
		try {
			await removeHubDiscovery(instanceId);
		} finally {
			await releaseLock(lock);
		}
	}
};
try {
	viewer = await startContextRailServer({ instanceId, token, viewerToken });
	await writeHubDiscovery({
		version: 1,
		instanceId,
		pid: process.pid,
		port: viewer.port,
		url: viewer.url,
		token,
		viewerToken,
		startedAt: Date.now(),
	});
} catch (error) {
	await cleanup();
	throw error;
}

let shuttingDown = false;
const shutdown = async (): Promise<void> => {
	if (shuttingDown) return;
	shuttingDown = true;
	await cleanup();
};

process.once("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.once("SIGTERM", () => void shutdown().then(() => process.exit(0)));
