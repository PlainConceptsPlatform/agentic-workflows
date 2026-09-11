// Every installed file carries the package version in its ownership header, stamped at
// install time. That version is the baseline an update merges against: the CLI fetches that
// exact release from npm and reads the file as it was when the consumer installed it.
import { exec as execCallback } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { access, mkdir, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";

const exec = promisify(execCallback);

export const PACKAGE_NAME = "@plainconceptsplatform/workflows";
const HEADER = `Managed by ${PACKAGE_NAME}`;
const VERSION = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?";
const STAMPED = new RegExp(`${escapeRegex(HEADER)}@(${VERSION})\\.`);
const UNSTAMPED = new RegExp(`${escapeRegex(HEADER)}\\.`);

export async function packageVersion(): Promise<string> {
  const manifest = fileURLToPath(new URL("../package.json", import.meta.url));
  const { version } = JSON.parse(await readFile(manifest, "utf8")) as { version: string };
  return version;
}

export function isValidVersion(version: string): boolean {
  return new RegExp(`^${VERSION}$`).test(version);
}

export function hasOwnershipHeader(content: string): boolean {
  return content.includes(HEADER);
}

/** The version recorded in a file's ownership header, or undefined for an unstamped file. */
export function installedVersion(content: string): string | undefined {
  return STAMPED.exec(content)?.[1];
}

/** Write the version into the ownership header. Re-stamping replaces the previous version. */
export function stampVersion(content: string, version: string): string {
  if (STAMPED.test(content)) return content.replace(STAMPED, `${HEADER}@${version}.`);
  return content.replace(UNSTAMPED, `${HEADER}@${version}.`);
}

export type BaselineFetcher = (version: string) => Promise<string | undefined>;

export interface FetchBaselineOptions {
  /** Where fetched releases are kept between runs. Defaults to the OS temp directory. */
  readonly cacheRoot?: string;
  /** Runs a shell command. Injected by tests. */
  readonly run?: (command: string) => Promise<void>;
}

/**
 * The `loops/` directory of a published release, or undefined when it cannot be had
 * (offline, unpublished version). The caller falls back to a two-way merge.
 */
export async function fetchBaseline(version: string, options: FetchBaselineOptions = {}): Promise<string | undefined> {
  if (!isValidVersion(version)) return undefined;
  const root = options.cacheRoot ?? join(tmpdir(), "plainconceptsplatform-workflows");
  const directory = join(root, version);
  const loops = join(directory, "package", "loops");
  if (await exists(loops)) return loops;

  const run = options.run ?? (async (command: string) => { await exec(command, { windowsHide: true }); });
  try {
    await mkdir(directory, { recursive: true });
    // npm honours the user's registry configuration, which a direct download would not.
    let tarball = await findTarball(directory);
    if (tarball === undefined) {
      await run(`npm pack "${PACKAGE_NAME}@${version}" --pack-destination "${directory}" --silent`);
      tarball = await findTarball(directory);
    }
    if (tarball === undefined) return undefined;
    // Extracted here rather than by a `tar` binary: the one on PATH may be GNU tar under
    // MSYS, which reads `C:\...` as a remote host, or missing altogether.
    extractTarball(await readFile(join(directory, tarball)), directory);
    return (await exists(loops)) ? loops : undefined;
  } catch {
    return undefined;
  }
}

async function findTarball(directory: string): Promise<string | undefined> {
  return (await readdir(directory)).find((file) => file.endsWith(".tgz"));
}

/**
 * Unpack a gzipped ustar/pax archive (what `npm pack` produces) into a directory. Regular files
 * and directories only; anything that would escape the destination is skipped.
 */
export function extractTarball(archive: Buffer, destination: string): void {
  const data = gunzipSync(archive);
  const field = (block: Buffer, start: number, length: number): string => {
    const raw = block.subarray(start, start + length);
    const end = raw.indexOf(0);
    return raw.subarray(0, end === -1 ? raw.length : end).toString("utf8");
  };

  let offset = 0;
  let longName: string | undefined;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    offset += 512;
    if (header.every((byte) => byte === 0)) break;

    const size = Number.parseInt(field(header, 124, 12).trim() || "0", 8);
    const type = field(header, 156, 1) || "0";
    const body = data.subarray(offset, offset + size);
    offset += Math.ceil(size / 512) * 512;

    if (type === "x" || type === "g") {
      // pax extended header: records of the form "<length> key=value\n"; `path` names the next entry.
      for (const record of body.toString("utf8").split("\n")) {
        const match = /^\d+ path=(.*)$/.exec(record);
        if (match !== null && type === "x") longName = match[1];
      }
      continue;
    }
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0+$/, "");
      continue;
    }

    const prefix = field(header, 345, 155);
    const shortName = field(header, 0, 100);
    const name = longName ?? (prefix === "" ? shortName : `${prefix}/${shortName}`);
    longName = undefined;

    const parts = name.split("/").filter((part) => part !== "" && part !== ".");
    if (parts.length === 0 || parts.includes("..")) continue;
    const target = join(destination, ...parts);

    if (type === "5") {
      mkdirSync(target, { recursive: true });
    } else if (type === "0") {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, body);
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
