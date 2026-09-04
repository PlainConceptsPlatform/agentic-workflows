import { cp, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const cliDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(cliDirectory, "..", "loops");
const destination = resolve(cliDirectory, "loops");

await rm(destination, { force: true, recursive: true });
await cp(source, destination, {
  filter: (path) => !path.endsWith(".lock.yml") && !path.endsWith("actions-lock.json"),
  recursive: true,
});
