import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directoryEntries, imageLayer } from "../src/ImageLayer.ts";

const longName = `${"nested-directory/".repeat(8)}module-with-a-long-name.js`;

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "image-layer-"));
  writeFileSync(join(root, "index.mjs"), "console.log('hello')");
  mkdirSync(join(root, "bin"));
  writeFileSync(join(root, "bin", "run"), "#!/bin/sh\n");
  chmodSync(join(root, "bin", "run"), 0o755);
  mkdirSync(join(root, longName, ".."), { recursive: true });
  writeFileSync(join(root, longName), "long");
  symlinkSync("../index.mjs", join(root, "bin", "entry"));
  return root;
};

const tar = (args: string[], archive: Uint8Array) => {
  const directory = mkdtempSync(join(tmpdir(), "image-layer-tar-"));
  const file = join(directory, "layer.tar.gz");
  writeFileSync(file, archive);
  const result = spawnSync("tar", [...args, "-f", file], { cwd: directory, encoding: "utf8" });
  expect(result.status).toBe(0);
  return { directory, stdout: result.stdout };
};

describe("imageLayer", () => {
  test("produces a gzipped tar that GNU tar lists and extracts under the prefix", async () => {
    const layer = imageLayer(await directoryEntries(fixture(), "app"));

    const listing = tar(["-tvz"], layer.data).stdout;
    expect(listing).toContain("drwxr-xr-x root/root");
    expect(listing).toContain("-rwxr-xr-x root/root");
    expect(listing).toContain(`app/${longName}`);
    expect(listing).toMatch(/app\/bin\/entry -> \.\.\/index\.mjs/);

    const { directory } = tar(["-xz"], layer.data);
    expect(await Bun.file(join(directory, "app", longName)).text()).toBe("long");
    expect(await Bun.file(join(directory, "app", "index.mjs")).text()).toBe("console.log('hello')");
  });

  test("is reproducible: the same tree always has the same digests", async () => {
    const first = imageLayer(await directoryEntries(fixture(), "app"));
    const second = imageLayer(await directoryEntries(fixture(), "app"));
    expect(second.digest).toBe(first.digest);
    expect(second.diffId).toBe(first.diffId);
    expect(first.digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(first.diffId).not.toBe(first.digest);
  });
});
