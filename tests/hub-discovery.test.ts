import assert from "node:assert/strict";
import {
	chmodSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	ensurePrivateDiscoveryDirectory,
	healthyHubDiscovery,
	readHubDiscovery,
	writeHubDiscovery,
} from "../src/hub-discovery.ts";
import type { ContextRailHubDiscovery } from "../src/hub-types.ts";

const PRIVATE_TOKEN = "a".repeat(43);
const PRIVATE_VIEWER_TOKEN = "b".repeat(43);

function validDiscovery(port = 41_237): ContextRailHubDiscovery {
	return {
		version: 1,
		instanceId: "6ff27722-95aa-4fc1-a308-f9706973d638",
		pid: process.pid,
		port,
		url: `http://127.0.0.1:${port}/`,
		token: PRIVATE_TOKEN,
		viewerToken: PRIVATE_VIEWER_TOKEN,
		startedAt: Date.now(),
	};
}

function withDiscoveryPath(t: test.TestContext, path: string): void {
	const previous = process.env.CONTEXT_RAIL_DISCOVERY_FILE;
	process.env.CONTEXT_RAIL_DISCOVERY_FILE = path;
	t.after(() => {
		if (previous === undefined) delete process.env.CONTEXT_RAIL_DISCOVERY_FILE;
		else process.env.CONTEXT_RAIL_DISCOVERY_FILE = previous;
	});
}

function fixture(t: test.TestContext): { directory: string; discoveryPath: string } {
	const root = mkdtempSync(join(tmpdir(), "context-rail-discovery-"));
	const directory = join(root, "private");
	mkdirSync(directory, { mode: 0o700 });
	t.after(() => rmSync(root, { force: true, recursive: true }));
	const discoveryPath = join(directory, "hub.json");
	withDiscoveryPath(t, discoveryPath);
	return { directory, discoveryPath };
}

function writeDiscovery(path: string, value: unknown, mode = 0o600): void {
	writeFileSync(path, JSON.stringify(value), { mode });
}

test("accepts a private discovery file with a strict loopback URL", async (t) => {
	const { discoveryPath } = fixture(t);
	const discovery = validDiscovery();
	writeDiscovery(discoveryPath, discovery);

	assert.deepEqual(await readHubDiscovery(), discovery);
});

test("tightens a user-owned discovery directory before reading secrets", async (t) => {
	if (typeof process.getuid !== "function") {
		t.skip("POSIX ownership and mode checks are unavailable");
		return;
	}
	const { directory, discoveryPath } = fixture(t);
	chmodSync(directory, 0o777);
	const discovery = validDiscovery();
	writeDiscovery(discoveryPath, discovery);

	assert.deepEqual(await readHubDiscovery(), discovery);
	assert.equal(lstatSync(directory).mode & 0o777, 0o700);
});

test("rejects a symlink discovery directory", async (t) => {
	const root = mkdtempSync(join(tmpdir(), "context-rail-discovery-link-dir-"));
	const target = join(root, "target");
	const linked = join(root, "linked");
	mkdirSync(target, { mode: 0o700 });
	symlinkSync(target, linked, "dir");
	const discoveryPath = join(linked, "hub.json");
	writeDiscovery(join(target, "hub.json"), validDiscovery());
	withDiscoveryPath(t, discoveryPath);
	t.after(() => rmSync(root, { force: true, recursive: true }));

	assert.equal(await readHubDiscovery(), undefined);
	await assert.rejects(ensurePrivateDiscoveryDirectory(discoveryPath), /symbolic link/i);
});

test("rejects symlink, non-regular, and overbroad discovery files", async (t) => {
	const { directory, discoveryPath } = fixture(t);
	const target = join(directory, "target.json");
	writeDiscovery(target, validDiscovery());
	symlinkSync(target, discoveryPath);
	assert.equal(await readHubDiscovery(), undefined);

	rmSync(discoveryPath);
	mkdirSync(discoveryPath);
	assert.equal(await readHubDiscovery(), undefined);

	rmSync(discoveryPath, { recursive: true });
	writeDiscovery(discoveryPath, validDiscovery(), 0o644);
	assert.equal(await readHubDiscovery(), undefined);
});

test("rejects a discovery directory owned by another POSIX user", async (t) => {
	if (typeof process.getuid !== "function") {
		t.skip("POSIX ownership checks are unavailable");
		return;
	}
	const { discoveryPath } = fixture(t);
	writeDiscovery(discoveryPath, validDiscovery());
	const originalGetuid = process.getuid;
	process.getuid = () => originalGetuid() + 1;
	try {
		assert.equal(await readHubDiscovery(), undefined);
		await assert.rejects(ensurePrivateDiscoveryDirectory(discoveryPath), /not owned/i);
	} finally {
		process.getuid = originalGetuid;
	}
});

test("rejects a relative environment override instead of trusting the working directory", async (t) => {
	withDiscoveryPath(t, "hub.json");
	assert.equal(await readHubDiscovery(), undefined);
	await assert.rejects(ensurePrivateDiscoveryDirectory(), /must be absolute/i);
});

test("rejects malformed fields and non-canonical URLs before network access", async () => {
	const originalFetch = globalThis.fetch;
	let requests = 0;
	globalThis.fetch = (() => {
		requests += 1;
		throw new Error("unexpected fetch");
	}) as typeof fetch;
	try {
		const valid = validDiscovery();
		const invalid: ContextRailHubDiscovery[] = [
			{ ...valid, pid: 0 },
			{ ...valid, pid: 0x80000000 },
			{ ...valid, port: 0 },
			{ ...valid, port: 65_536 },
			{ ...valid, token: "short" },
			{ ...valid, token: "a".repeat(257) },
			{ ...valid, viewerToken: "short" },
			{ ...valid, viewerToken: "b".repeat(257) },
			{ ...valid, viewerToken: valid.token },
			{ ...valid, instanceId: "" },
			{ ...valid, instanceId: "a".repeat(129) },
			{ ...valid, startedAt: -1 },
			{ ...valid, url: "http://example.com:41237/" },
			{ ...valid, url: "https://127.0.0.1:41237/" },
			{ ...valid, url: "http://user@127.0.0.1:41237/" },
			{ ...valid, url: "http://127.0.0.1:41237/api" },
			{ ...valid, url: "http://127.0.0.1:41237/?token=leak" },
			{ ...valid, url: "http://127.0.0.1:41237/#fragment" },
			{ ...valid, url: "http://127.0.0.1:41238/" },
		];

		for (const discovery of invalid) {
			assert.equal(await healthyHubDiscovery(discovery), undefined, discovery.url);
		}
		assert.equal(requests, 0);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("health checks only the validated loopback health endpoint", async () => {
	const originalFetch = globalThis.fetch;
	const discovery = validDiscovery();
	let requestedUrl = "";
	globalThis.fetch = (async (input) => {
		requestedUrl = String(input);
		return new Response(JSON.stringify({ ok: true, instanceId: discovery.instanceId }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		});
	}) as typeof fetch;
	try {
		assert.deepEqual(await healthyHubDiscovery(discovery), discovery);
		assert.equal(requestedUrl, `${discovery.url}health`);
	} finally {
		globalThis.fetch = originalFetch;
	}
});

test("writes first-start discovery metadata with private directory and file modes", async (t) => {
	if (typeof process.getuid !== "function") {
		t.skip("POSIX ownership and mode checks are unavailable");
		return;
	}
	const root = mkdtempSync(join(tmpdir(), "context-rail-discovery-write-"));
	const discoveryPath = join(root, "new", "hub.json");
	withDiscoveryPath(t, discoveryPath);
	t.after(() => rmSync(root, { force: true, recursive: true }));
	const discovery = validDiscovery();

	await writeHubDiscovery(discovery);

	assert.equal(lstatSync(join(root, "new")).mode & 0o777, 0o700);
	assert.equal(lstatSync(discoveryPath).mode & 0o777, 0o600);
	assert.deepEqual(await readHubDiscovery(), discovery);
});
