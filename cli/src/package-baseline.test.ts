import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import { extractTarball, fetchBaseline, hasOwnershipHeader, installedVersion, isValidVersion, packageVersion, stampVersion } from "./package-baseline.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

const yamlHeader = "# Managed by @plainconceptsplatform/workflows. Source: loops/workflows/work-router.yml. Update with `workflows update --force`; consumer edits may be overwritten.\nname: x\n";
const markdownHeader = "---\n# Managed by @plainconceptsplatform/workflows. Source: loops/workflows/agent-refine.md. Update with `workflows update --force`; consumer edits may be overwritten.\nenv:\n  A: \"1\"\n---\nbody\n";
const scriptHeader = "// Managed by @plainconceptsplatform/workflows. Source: loops/scripts/compile-agent-workflows.mjs. Update with `workflows update --force`; consumer edits may be overwritten.\nconst x = 1;\n";

describe("version stamp", () => {
  it("writes the version into every header style and reads it back", () => {
    for (const content of [yamlHeader, markdownHeader, scriptHeader]) {
      const stamped = stampVersion(content, "0.7.0");
      expect(stamped).toContain("Managed by @plainconceptsplatform/workflows@0.7.0. Source: loops/");
      expect(installedVersion(stamped)).toBe("0.7.0");
      expect(stamped.replace("@0.7.0", "")).toBe(content);
    }
  });

  it("replaces a previous stamp rather than adding a second one", () => {
    const once = stampVersion(yamlHeader, "0.6.1");
    const twice = stampVersion(once, "0.7.0");
    expect(installedVersion(twice)).toBe("0.7.0");
    expect(twice).not.toContain("0.6.1");
    expect(twice.split("Managed by").length).toBe(2);
  });

  it("reads pre-release versions and reports an unstamped file as undefined", () => {
    expect(installedVersion(stampVersion(yamlHeader, "1.0.0-beta.2"))).toBe("1.0.0-beta.2");
    expect(installedVersion(yamlHeader)).toBeUndefined();
  });

  it("leaves a file without an ownership header alone", () => {
    expect(stampVersion("name: mine\n", "0.7.0")).toBe("name: mine\n");
    expect(hasOwnershipHeader("name: mine\n")).toBe(false);
    expect(hasOwnershipHeader(yamlHeader)).toBe(true);
  });

  it("validates versions before they reach a shell", () => {
    expect(isValidVersion("0.7.0")).toBe(true);
    expect(isValidVersion("1.2.3-rc.1")).toBe(true);
    expect(isValidVersion("0.7")).toBe(false);
    expect(isValidVersion("0.7.0; rm -rf /")).toBe(false);
  });

  it("reports this package's own version", async () => {
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    await expect(packageVersion()).resolves.toBe(manifest.version);
  });
});

describe("extractTarball", () => {
  it("unpacks regular files, honouring pax long names and skipping paths that escape", async () => {
    const directory = await createDirectory();
    const longPath = `package/loops/${"deep/".repeat(30)}file.md`;
    const archive = tarGz([
      { name: "package/loops/workflows/agent-check.md", content: "---\nenv:\n  A: \"1\"\n---\n" },
      { name: "package/loops/dir/", content: "", type: "5" },
      { name: longPath, content: "long", pax: true },
      { name: "../escape.txt", content: "nope" },
    ]);

    extractTarball(archive, directory);

    await expect(readFile(join(directory, "package/loops/workflows/agent-check.md"), "utf8")).resolves.toBe("---\nenv:\n  A: \"1\"\n---\n");
    await expect(readFile(join(directory, ...longPath.split("/")), "utf8")).resolves.toBe("long");
    await expect(readFile(join(directory, "..", "escape.txt"), "utf8")).rejects.toThrow();
  });
});

describe("fetchBaseline", () => {
  it("reuses a release already in the cache without running anything", async () => {
    const cacheRoot = await createDirectory();
    await mkdir(join(cacheRoot, "0.6.1", "package", "loops"), { recursive: true });
    const commands: string[] = [];

    await expect(fetchBaseline("0.6.1", { cacheRoot, run: async (command) => { commands.push(command); } }))
      .resolves.toBe(join(cacheRoot, "0.6.1", "package", "loops"));
    expect(commands).toEqual([]);
  });

  it("packs the release with npm and extracts it into the cache", async () => {
    const cacheRoot = await createDirectory();
    const commands: string[] = [];
    const run = async (command: string): Promise<void> => {
      commands.push(command);
      await writeFile(
        join(cacheRoot, "0.6.1", "plainconceptsplatform-workflows-0.6.1.tgz"),
        tarGz([{ name: "package/loops/workflows/agent-check.md", content: "old default\n" }]),
      );
    };

    await expect(fetchBaseline("0.6.1", { cacheRoot, run })).resolves.toBe(join(cacheRoot, "0.6.1", "package", "loops"));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("npm pack \"@plainconceptsplatform/workflows@0.6.1\"");
    await expect(readFile(join(cacheRoot, "0.6.1", "package", "loops", "workflows", "agent-check.md"), "utf8")).resolves.toBe("old default\n");
  });

  it("extracts a tarball left by an earlier run without packing again", async () => {
    const cacheRoot = await createDirectory();
    await mkdir(join(cacheRoot, "0.6.1"), { recursive: true });
    await writeFile(join(cacheRoot, "0.6.1", "x.tgz"), tarGz([{ name: "package/loops/README.md", content: "x" }]));
    const commands: string[] = [];

    await expect(fetchBaseline("0.6.1", { cacheRoot, run: async (command) => { commands.push(command); } }))
      .resolves.toBe(join(cacheRoot, "0.6.1", "package", "loops"));
    expect(commands).toEqual([]);
  });

  it("returns undefined when the release cannot be fetched, the archive is corrupt, or the version is malformed", async () => {
    const cacheRoot = await createDirectory();
    await expect(fetchBaseline("0.6.1", { cacheRoot, run: async () => { throw new Error("offline"); } })).resolves.toBeUndefined();
    await expect(fetchBaseline("0.6.2", {
      cacheRoot,
      run: async () => { await writeFile(join(cacheRoot, "0.6.2", "x.tgz"), "not a tarball"); },
    })).resolves.toBeUndefined();
    await expect(fetchBaseline("not-a-version", { cacheRoot, run: async () => undefined })).resolves.toBeUndefined();
  });
});

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "workflows-baseline-"));
  temporaryDirectories.push(directory);
  return directory;
}

interface TarEntry {
  readonly name: string;
  readonly content: string;
  readonly type?: "0" | "5";
  /** Emit the name through a pax extended header, as node-tar does for long paths. */
  readonly pax?: boolean;
}

// A minimal ustar writer: enough of the format to exercise the reader.
function tarGz(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  const block = (name: string, body: Buffer, type: string): void => {
    const header = Buffer.alloc(512);
    header.write(name, 0, 100, "utf8");
    header.write("0000644\0", 100, 8, "utf8");
    header.write("0000000\0", 108, 8, "utf8");
    header.write("0000000\0", 116, 8, "utf8");
    header.write(`${body.length.toString(8).padStart(11, "0")}\0`, 124, 12, "utf8");
    header.write("00000000000\0", 136, 12, "utf8");
    header.write("        ", 148, 8, "utf8");
    header.write(type, 156, 1, "utf8");
    header.write("ustar\0", 257, 6, "utf8");
    header.write("00", 263, 2, "utf8");
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "utf8");
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
  };
  for (const entry of entries) {
    if (entry.pax) {
      const record = ` path=${entry.name}\n`;
      const length = record.length + String(record.length + 2).length;
      block("PaxHeader", Buffer.from(`${length}${record}`, "utf8"), "x");
      block("truncated", Buffer.from(entry.content, "utf8"), entry.type ?? "0");
    } else {
      block(entry.name, Buffer.from(entry.content, "utf8"), entry.type ?? "0");
    }
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks));
}
