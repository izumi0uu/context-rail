import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

interface Discovery {
	instanceId: string;
	pid: number;
	port: number;
	token: string;
	url: string;
	viewerToken: string;
}

interface LockLease {
	version: 1;
	ownerId: string;
	pid: number;
}

const CLI_PATH = fileURLToPath(new URL("../src/hub-cli.ts", import.meta.url));
const TEST_LOCK_REMOVAL_READY = "context-rail:test:lock-removal-ready";
const TEST_LOCK_REMOVAL_CONTINUE = "context-rail:test:lock-removal-continue";

function writeLockLease(path: string, pid: number, ownerId: string): LockLease {
	const lease: LockLease = { version: 1, ownerId, pid };
	writeFileSync(path, JSON.stringify(lease));
	return lease;
}

function readLockLease(path: string): LockLease {
	return JSON.parse(readFileSync(path, "utf8")) as LockLease;
}

function startCli(discoveryPath: string, ...args: string[]): ChildProcess {
	return spawn(process.execPath, ["--experimental-strip-types", CLI_PATH, ...args], {
		env: { ...process.env, CONTEXT_RAIL_DISCOVERY_FILE: discoveryPath },
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function startCliAtLockRemovalBarrier(discoveryPath: string): ChildProcess {
	return spawn(process.execPath, ["--experimental-strip-types", CLI_PATH], {
		env: {
			...process.env,
			CONTEXT_RAIL_DISCOVERY_FILE: discoveryPath,
			CONTEXT_RAIL_TEST_LOCK_REMOVAL_BARRIER: "1",
			NODE_ENV: "test",
		},
		stdio: ["ignore", "pipe", "pipe", "ipc"],
	});
}

async function waitForLockRemovalBarrier(
	child: ChildProcess,
	timeoutMs = 2_000,
): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const cleanup = (): void => {
			clearTimeout(timeout);
			child.off("error", onError);
			child.off("exit", onExit);
			child.off("message", onMessage);
		};
		const onError = (error: Error): void => {
			cleanup();
			reject(error);
		};
		const onExit = (): void => {
			cleanup();
			reject(new Error("ContextRail test Hub exited before lock removal"));
		};
		const onMessage = (message: unknown): void => {
			if (message !== TEST_LOCK_REMOVAL_READY) return;
			cleanup();
			resolve();
		};
		const timeout = setTimeout(() => {
			cleanup();
			reject(new Error("ContextRail test Hub did not reach lock removal"));
		}, timeoutMs);
		child.once("error", onError);
		child.once("exit", onExit);
		child.on("message", onMessage);
	});
}

async function runCli(
	discoveryPath: string,
	...args: string[]
): Promise<{ code: number | null; stderr: string; stdout: string }> {
	const child = startCli(discoveryPath, ...args);
	let stdout = "";
	let stderr = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		stdout += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		stderr += chunk.toString();
	});
	const code = await new Promise<number | null>((resolve, reject) => {
		child.once("error", reject);
		child.once("exit", resolve);
	});
	return { code, stderr, stdout };
}

async function waitForDiscovery(path: string, timeoutMs = 5_000): Promise<Discovery> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const discovery = JSON.parse(readFileSync(path, "utf8")) as Discovery;
			const health = await fetch(`${discovery.url}health`, {
				signal: AbortSignal.timeout(250),
			});
			if (health.ok) return discovery;
		} catch {
			// The Hub is still starting.
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	throw new Error("ContextRail test Hub did not become ready");
}

async function exitsWithin(child: ChildProcess, timeoutMs: number): Promise<boolean> {
	if (child.exitCode !== null || child.signalCode !== null) return true;
	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			child.off("exit", exited);
			resolve(false);
		}, timeoutMs);
		const exited = (): void => {
			clearTimeout(timeout);
			resolve(true);
		};
		child.once("exit", exited);
	});
}

async function waitForExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

test("stop waits for the old Hub to exit and permits an immediate restart", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "context-rail-stop-"));
	const discoveryPath = join(directory, "hub.json");
	const lockPath = `${discoveryPath}.lock`;
	const hubs: ChildProcess[] = [];
	t.after(async () => {
		for (const hub of hubs) {
			if (hub.exitCode === null && hub.signalCode === null) hub.kill("SIGTERM");
		}
		await Promise.all(hubs.map((hub) => waitForExit(hub)));
		rmSync(directory, { force: true, recursive: true });
	});

	const firstHub = startCli(discoveryPath);
	hubs.push(firstHub);
	const first = await waitForDiscovery(discoveryPath);
	assert.match(first.token, /^[a-zA-Z0-9_-]{43}$/);
	assert.match(first.viewerToken, /^[a-zA-Z0-9_-]{43}$/);
	assert.notEqual(first.viewerToken, first.token);
	const producerRead = await fetch(`${first.url}events?token=${encodeURIComponent(first.token)}`);
	assert.equal(producerRead.status, 401);
	const viewerRead = await fetch(`${first.url}events?token=${encodeURIComponent(first.viewerToken)}`);
	assert.equal(viewerRead.status, 200);
	await viewerRead.body?.cancel();
	rmSync(lockPath);
	writeFileSync(lockPath, String(first.pid));

	const blocker = connect(first.port, "127.0.0.1");
	await new Promise<void>((resolve, reject) => {
		blocker.once("connect", resolve);
		blocker.once("error", reject);
	});
	blocker.write(
		`POST /api/heartbeat HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer ${first.token}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`,
	);
	const releaseBlocker = setTimeout(() => blocker.destroy(), 200);

	const startedAt = Date.now();
	const stopped = await runCli(discoveryPath, "stop");
	clearTimeout(releaseBlocker);
	blocker.destroy();
	assert.equal(stopped.code, 0, stopped.stderr);
	assert.match(stopped.stdout, /ContextRail Hub stopped/);
	assert.ok(Date.now() - startedAt >= 150, "stop returned before the old Hub exited");
	assert.notEqual(firstHub.exitCode, null);
	assert.equal(existsSync(discoveryPath), false);
	assert.equal(existsSync(lockPath), false);

	const secondHub = startCli(discoveryPath);
	hubs.push(secondHub);
	const second = await waitForDiscovery(discoveryPath);
	assert.notEqual(second.instanceId, first.instanceId);

	const stoppedAgain = await runCli(discoveryPath, "stop");
	assert.equal(stoppedAgain.code, 0, stoppedAgain.stderr);
	assert.match(stoppedAgain.stdout, /ContextRail Hub stopped/);
	assert.equal(existsSync(discoveryPath), false);
	assert.equal(existsSync(lockPath), false);
});

test("does not steal a fresh legacy lease from a live owner", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "context-rail-live-lock-"));
	const discoveryPath = join(directory, "hub.json");
	const lockPath = `${discoveryPath}.lock`;
	const owner = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
		stdio: "ignore",
	});
	await new Promise<void>((resolve, reject) => {
		owner.once("spawn", resolve);
		owner.once("error", reject);
	});
	assert.ok(owner.pid);
	writeFileSync(lockPath, String(owner.pid));

	const contender = startCli(discoveryPath);
	t.after(async () => {
		if (contender.exitCode === null && contender.signalCode === null) contender.kill("SIGTERM");
		if (owner.exitCode === null && owner.signalCode === null) owner.kill("SIGTERM");
		await Promise.all([waitForExit(contender), waitForExit(owner)]);
		rmSync(directory, { force: true, recursive: true });
	});

	assert.equal(await exitsWithin(contender, 1_000), true, "contender did not yield to live owner");
	assert.equal(contender.exitCode, 0);
	assert.equal(readFileSync(lockPath, "utf8"), String(owner.pid));
	assert.equal(existsSync(discoveryPath), false);
});

test("reclaims a stale legacy lease from a live reused PID", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "context-rail-reused-pid-"));
	const discoveryPath = join(directory, "hub.json");
	const lockPath = `${discoveryPath}.lock`;
	writeFileSync(lockPath, String(process.pid));
	const stale = new Date(Date.now() - 30_000);
	utimesSync(lockPath, stale, stale);

	const hub = startCli(discoveryPath);
	t.after(async () => {
		if (hub.exitCode === null && hub.signalCode === null) hub.kill("SIGTERM");
		await waitForExit(hub);
		rmSync(directory, { force: true, recursive: true });
	});

	const discovery = await waitForDiscovery(discoveryPath, 2_000);
	const replacement = readLockLease(lockPath);
	assert.equal(replacement.ownerId, discovery.instanceId);
	assert.equal(replacement.pid, hub.pid);
});

test("reclaims a fresh legacy lock immediately when its owner is dead", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "context-rail-dead-lock-"));
	const discoveryPath = join(directory, "hub.json");
	const lockPath = `${discoveryPath}.lock`;
	const formerOwner = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
	await waitForExit(formerOwner);
	assert.ok(formerOwner.pid);
	writeFileSync(lockPath, String(formerOwner.pid));

	const hub = startCli(discoveryPath);
	t.after(async () => {
		if (hub.exitCode === null && hub.signalCode === null) hub.kill("SIGTERM");
		await waitForExit(hub);
		rmSync(directory, { force: true, recursive: true });
	});

	const discovery = await waitForDiscovery(discoveryPath, 2_000);
	assert.equal(discovery.pid, hub.pid);
	assert.notEqual(discovery.pid, formerOwner.pid);
});

test("a fresh malformed lock yields without unbounded retries", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "context-rail-fresh-malformed-lock-"));
	const discoveryPath = join(directory, "hub.json");
	const lockPath = `${discoveryPath}.lock`;
	writeFileSync(lockPath, "{not-json");

	const contender = startCli(discoveryPath);
	t.after(async () => {
		if (contender.exitCode === null && contender.signalCode === null) contender.kill("SIGTERM");
		await waitForExit(contender);
		rmSync(directory, { force: true, recursive: true });
	});

	assert.equal(await exitsWithin(contender, 1_000), true, "contender retried a fresh malformed lock");
	assert.equal(contender.exitCode, 0);
	assert.equal(readFileSync(lockPath, "utf8"), "{not-json");
	assert.equal(existsSync(discoveryPath), false);
});

test("reclaims a stale malformed owner without unbounded retries", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "context-rail-malformed-lock-"));
	const discoveryPath = join(directory, "hub.json");
	const lockPath = `${discoveryPath}.lock`;
	writeFileSync(lockPath, "999999999999");
	const stale = new Date(Date.now() - 30_000);
	utimesSync(lockPath, stale, stale);

	const hub = startCli(discoveryPath);
	t.after(async () => {
		if (hub.exitCode === null && hub.signalCode === null) hub.kill("SIGTERM");
		await waitForExit(hub);
		rmSync(directory, { force: true, recursive: true });
	});

	const discovery = await waitForDiscovery(discoveryPath, 2_000);
	assert.equal(discovery.pid, hub.pid);
});

test("the active owner refreshes the lease mtime", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "context-rail-heartbeat-lock-"));
	const discoveryPath = join(directory, "hub.json");
	const lockPath = `${discoveryPath}.lock`;
	const hub = startCli(discoveryPath);
	t.after(async () => {
		if (hub.exitCode === null && hub.signalCode === null) hub.kill("SIGTERM");
		await waitForExit(hub);
		rmSync(directory, { force: true, recursive: true });
	});

	await waitForDiscovery(discoveryPath);
	const initialMtime = statSync(lockPath).mtimeMs;
	const deadline = Date.now() + 4_000;
	while (statSync(lockPath).mtimeMs <= initialMtime && Date.now() < deadline) {
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	assert.ok(statSync(lockPath).mtimeMs > initialMtime, "lease heartbeat did not advance mtime");
});

test("does not reclaim a stale lease after its heartbeat recovers", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "context-rail-recovered-lock-"));
	const discoveryPath = join(directory, "hub.json");
	const lockPath = `${discoveryPath}.lock`;
	const original = writeLockLease(lockPath, process.pid, "recovering-owner");
	const stale = new Date(Date.now() - 30_000);
	utimesSync(lockPath, stale, stale);

	const contender = startCliAtLockRemovalBarrier(discoveryPath);
	t.after(async () => {
		if (contender.exitCode === null && contender.signalCode === null) contender.kill("SIGTERM");
		await waitForExit(contender);
		rmSync(directory, { force: true, recursive: true });
	});

	await waitForLockRemovalBarrier(contender);
	const recovered = new Date();
	utimesSync(lockPath, recovered, recovered);
	contender.send?.(TEST_LOCK_REMOVAL_CONTINUE);

	assert.equal(await exitsWithin(contender, 1_000), true, "contender ignored recovered lease");
	assert.equal(contender.exitCode, 0);
	assert.deepEqual(readLockLease(lockPath), original);
	assert.ok(statSync(lockPath).mtimeMs >= recovered.getTime() - 1);
	assert.equal(existsSync(discoveryPath), false);
});

test("does not remove a replacement installed after its first revalidation", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "context-rail-raced-replacement-"));
	const discoveryPath = join(directory, "hub.json");
	const lockPath = `${discoveryPath}.lock`;
	writeLockLease(lockPath, process.pid, "stale-owner");
	const stale = new Date(Date.now() - 30_000);
	utimesSync(lockPath, stale, stale);

	const contender = startCliAtLockRemovalBarrier(discoveryPath);
	t.after(async () => {
		if (contender.exitCode === null && contender.signalCode === null) contender.kill("SIGTERM");
		await waitForExit(contender);
		rmSync(directory, { force: true, recursive: true });
	});

	await waitForLockRemovalBarrier(contender);
	rmSync(lockPath);
	const replacement = writeLockLease(lockPath, process.pid, "replacement-owner");
	contender.send?.(TEST_LOCK_REMOVAL_CONTINUE);

	assert.equal(await exitsWithin(contender, 1_000), true, "contender ignored replacement lease");
	assert.equal(contender.exitCode, 0);
	assert.deepEqual(readLockLease(lockPath), replacement);
	assert.equal(existsSync(discoveryPath), false);
});

test("an old owner cannot remove a replacement lease with the same PID", async (t) => {
	const directory = mkdtempSync(join(tmpdir(), "context-rail-replaced-lock-"));
	const discoveryPath = join(directory, "hub.json");
	const lockPath = `${discoveryPath}.lock`;
	const hub = startCli(discoveryPath);
	t.after(async () => {
		if (hub.exitCode === null && hub.signalCode === null) hub.kill("SIGTERM");
		await waitForExit(hub);
		rmSync(directory, { force: true, recursive: true });
	});

	await waitForDiscovery(discoveryPath);
	assert.ok(hub.pid);
	rmSync(lockPath);
	const replacement = writeLockLease(lockPath, hub.pid, "replacement-owner");
	hub.kill("SIGTERM");
	await waitForExit(hub);

	assert.deepEqual(readLockLease(lockPath), replacement);
	assert.equal(existsSync(discoveryPath), false);
});
