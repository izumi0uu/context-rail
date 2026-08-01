import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { ContextRailHubDiscovery } from "./hub-types.ts";

const MAX_DISCOVERY_BYTES = 16 * 1024;
const MAX_INSTANCE_ID_LENGTH = 128;
const MIN_TOKEN_LENGTH = 32;
const MAX_TOKEN_LENGTH = 256;
const POSIX_SHARED_MODE_MASK = 0o077;

function ownerKey(): string {
	const key = typeof process.getuid === "function" ? process.getuid() : process.env.USERNAME ?? "user";
	return String(key).replaceAll(/[^a-zA-Z0-9_-]/g, "-");
}

export function contextRailDiscoveryPath(): string {
	const path =
		process.env.CONTEXT_RAIL_DISCOVERY_FILE ??
		join(tmpdir(), `context-rail-${ownerKey()}`, "hub.json");
	if (!isAbsolute(path)) {
		throw new Error("ContextRail discovery path must be absolute");
	}
	return path;
}

export function contextRailLockPath(): string {
	return `${contextRailDiscoveryPath()}.lock`;
}

function errorCode(error: unknown): unknown {
	return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

function hasPosixIdentity(): boolean {
	return typeof process.getuid === "function";
}

function assertPrivateOwner(
	path: string,
	stats: Stats,
	kind: "directory" | "file",
): void {
	if (!hasPosixIdentity()) return;
	const uid = process.getuid!();
	if (stats.uid !== uid) {
		throw new Error(`ContextRail discovery ${kind} is not owned by the current user: ${path}`);
	}
	if ((stats.mode & POSIX_SHARED_MODE_MASK) !== 0) {
		throw new Error(`ContextRail discovery ${kind} permits group or other access: ${path}`);
	}
}

async function secureDiscoveryDirectory(path: string, create: boolean): Promise<boolean> {
	if (!isAbsolute(path)) throw new Error("ContextRail discovery path must be absolute");
	const directory = dirname(path);
	if (create) await mkdir(directory, { recursive: true, mode: 0o700 });

	let stats: Stats;
	try {
		stats = await lstat(directory);
	} catch (error) {
		if (!create && errorCode(error) === "ENOENT") return false;
		throw error;
	}
	if (stats.isSymbolicLink()) {
		throw new Error(`ContextRail discovery directory must not be a symbolic link: ${directory}`);
	}
	if (!stats.isDirectory()) {
		throw new Error(`ContextRail discovery parent is not a directory: ${directory}`);
	}

	if (hasPosixIdentity()) {
		const uid = process.getuid!();
		if (stats.uid !== uid) {
			throw new Error(`ContextRail discovery directory is not owned by the current user: ${directory}`);
		}
		if ((stats.mode & POSIX_SHARED_MODE_MASK) !== 0) {
			await chmod(directory, 0o700);
			stats = await lstat(directory);
			if (stats.isSymbolicLink() || !stats.isDirectory()) {
				throw new Error(`ContextRail discovery parent changed during validation: ${directory}`);
			}
		}
		assertPrivateOwner(directory, stats, "directory");
	}
	return true;
}

export async function ensurePrivateDiscoveryDirectory(
	path = contextRailDiscoveryPath(),
): Promise<void> {
	await secureDiscoveryDirectory(path, true);
}

function boundedIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_INSTANCE_ID_LENGTH &&
		/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/.test(value)
	);
}

function privateToken(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length >= MIN_TOKEN_LENGTH &&
		value.length <= MAX_TOKEN_LENGTH &&
		/^[a-zA-Z0-9_-]+$/.test(value)
	);
}

function validPid(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value > 0 &&
		value <= 0x7fffffff
	);
}

function validPort(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= 65_535;
}

function strictLoopbackUrl(value: unknown, port: number): value is string {
	if (typeof value !== "string" || value !== `http://127.0.0.1:${port}/`) return false;
	try {
		const parsed = new URL(value);
		const parsedPort = parsed.port === "" && port === 80 ? 80 : Number(parsed.port);
		return (
			parsed.protocol === "http:" &&
			parsed.hostname === "127.0.0.1" &&
			parsedPort === port &&
			parsed.pathname === "/" &&
			parsed.search === "" &&
			parsed.hash === "" &&
			parsed.username === "" &&
			parsed.password === ""
		);
	} catch {
		return false;
	}
}

function validateHubDiscovery(value: unknown): ContextRailHubDiscovery | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const parsed = value as Partial<ContextRailHubDiscovery>;
	if (
		parsed.version !== 1 ||
		!boundedIdentifier(parsed.instanceId) ||
		!validPid(parsed.pid) ||
		!validPort(parsed.port) ||
		!strictLoopbackUrl(parsed.url, parsed.port) ||
		!privateToken(parsed.token) ||
		!privateToken(parsed.viewerToken) ||
		parsed.viewerToken === parsed.token ||
		typeof parsed.startedAt !== "number" ||
		!Number.isSafeInteger(parsed.startedAt) ||
		parsed.startedAt < 0
	) {
		return undefined;
	}
	return parsed as ContextRailHubDiscovery;
}

async function readPrivateDiscoveryFile(path: string): Promise<string | undefined> {
	if (!(await secureDiscoveryDirectory(path, false))) return undefined;
	let pathStats: Stats;
	try {
		pathStats = await lstat(path);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
	if (pathStats.isSymbolicLink() || !pathStats.isFile()) return undefined;
	assertPrivateOwner(path, pathStats, "file");
	if (pathStats.size > MAX_DISCOVERY_BYTES) return undefined;

	const flags =
		process.platform === "win32" ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, flags);
		const stats = await handle.stat();
		if (!stats.isFile() || stats.dev !== pathStats.dev || stats.ino !== pathStats.ino) return undefined;
		assertPrivateOwner(path, stats, "file");
		if (stats.size > MAX_DISCOVERY_BYTES) return undefined;
		const contents = await handle.readFile("utf8");
		return Buffer.byteLength(contents) <= MAX_DISCOVERY_BYTES ? contents : undefined;
	} catch (error) {
		if (errorCode(error) === "ENOENT" || errorCode(error) === "ELOOP") return undefined;
		throw error;
	} finally {
		await handle?.close();
	}
}

export async function readHubDiscovery(): Promise<ContextRailHubDiscovery | undefined> {
	try {
		const contents = await readPrivateDiscoveryFile(contextRailDiscoveryPath());
		return contents === undefined ? undefined : validateHubDiscovery(JSON.parse(contents) as unknown);
	} catch {
		return undefined;
	}
}

export async function writeHubDiscovery(discovery: ContextRailHubDiscovery): Promise<void> {
	const validated = validateHubDiscovery(discovery);
	if (!validated) throw new Error("Refusing to write invalid ContextRail discovery metadata");
	const path = contextRailDiscoveryPath();
	await ensurePrivateDiscoveryDirectory(path);
	const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(temporary, "wx", 0o600);
		await handle.writeFile(JSON.stringify(validated), "utf8");
		await handle.close();
		handle = undefined;
		await rename(temporary, path);
	} finally {
		await handle?.close();
		await rm(temporary, { force: true });
	}
}

export async function removeHubDiscovery(instanceId: string): Promise<void> {
	const current = await readHubDiscovery();
	if (current?.instanceId !== instanceId) return;
	await rm(contextRailDiscoveryPath(), { force: true });
}

export async function healthyHubDiscovery(
	discovery?: ContextRailHubDiscovery,
): Promise<ContextRailHubDiscovery | undefined> {
	const validated = discovery === undefined ? await readHubDiscovery() : validateHubDiscovery(discovery);
	if (!validated) return undefined;
	try {
		const response = await fetch(`${validated.url}health`, {
			signal: AbortSignal.timeout(500),
		});
		if (!response.ok) return undefined;
		const health = (await response.json()) as { ok?: unknown; instanceId?: unknown };
		return health.ok === true && health.instanceId === validated.instanceId ? validated : undefined;
	} catch {
		return undefined;
	}
}
