/**
 * Deterministic OCI image layers built in TypeScript, without a Docker daemon.
 *
 * A layer is a gzipped tar of a local directory placed under a path inside
 * the image. Entries are sorted, owned by root and stamped with mtime 0, so
 * the same directory always yields the same layer digest. Long paths use PAX
 * extended headers.
 */
import { createHash } from "node:crypto";
import { lstat, readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

export interface LayerEntry {
  /** Path inside the image, without a leading slash. Directories end with `/`. */
  path: string;
  type: "file" | "directory" | "symlink";
  mode: number;
  content?: Uint8Array;
  linkTarget?: string;
}

export interface ImageLayer {
  /** Gzipped tar bytes pushed as the layer blob. */
  data: Uint8Array;
  /** Digest of `data`. */
  digest: string;
  /** Digest of the uncompressed tar, recorded in the image config's `rootfs.diff_ids`. */
  diffId: string;
}

const BLOCK = 512;
const encoder = new TextEncoder();

const sha256 = (data: Uint8Array) => `sha256:${createHash("sha256").update(data).digest("hex")}`;

const octal = (value: number, width: number) => `${value.toString(8).padStart(width - 1, "0")}\0`;

const paxRecord = (key: string, value: string) => {
  const body = ` ${key}=${value}\n`;
  let length = encoder.encode(body).byteLength + 1;
  while (encoder.encode(`${length}${body}`).byteLength !== length) length += 1;
  return `${length}${body}`;
};

const typeFlag = { file: "0", symlink: "2", directory: "5", pax: "x" } as const;

const header = (fields: {
  name: string;
  mode: number;
  size: number;
  type: keyof typeof typeFlag;
  linkname?: string;
}) => {
  const block = new Uint8Array(BLOCK);
  const write = (offset: number, value: string, width: number) => {
    block.set(encoder.encode(value).subarray(0, width), offset);
  };
  write(0, fields.name, 100);
  write(100, octal(fields.mode, 8), 8);
  write(108, octal(0, 8), 8);
  write(116, octal(0, 8), 8);
  write(124, octal(fields.size, 12), 12);
  write(136, octal(0, 12), 12);
  write(148, "        ", 8);
  write(156, typeFlag[fields.type], 1);
  write(157, fields.linkname ?? "", 100);
  write(257, "ustar\0", 6);
  write(263, "00", 2);
  write(265, "root", 32);
  write(297, "root", 32);
  const checksum = block.reduce((sum, byte) => sum + byte, 0);
  write(148, `${checksum.toString(8).padStart(6, "0")}\0 `, 8);
  return block;
};

const padded = (data: Uint8Array) => {
  const size = Math.ceil(data.byteLength / BLOCK) * BLOCK;
  if (size === data.byteLength) return data;
  const out = new Uint8Array(size);
  out.set(data);
  return out;
};

const fits = (value: string) => encoder.encode(value).byteLength <= 100;

const entryBlocks = (entry: LayerEntry): Uint8Array[] => {
  const blocks: Uint8Array[] = [];
  const records = [
    ...(fits(entry.path) ? [] : [paxRecord("path", entry.path)]),
    ...(entry.linkTarget === undefined || fits(entry.linkTarget) ? [] : [paxRecord("linkpath", entry.linkTarget)]),
  ];
  if (records.length > 0) {
    const pax = encoder.encode(records.join(""));
    blocks.push(header({ name: "PaxHeader", mode: 0o644, size: pax.byteLength, type: "pax" }), padded(pax));
  }
  const content = entry.type === "file" ? (entry.content ?? new Uint8Array()) : new Uint8Array();
  blocks.push(
    header({
      name: fits(entry.path) ? entry.path : entry.path.slice(0, 100),
      mode: entry.mode,
      size: content.byteLength,
      type: entry.type,
      linkname: entry.linkTarget !== undefined && fits(entry.linkTarget) ? entry.linkTarget : undefined,
    }),
  );
  if (content.byteLength > 0) blocks.push(padded(content));
  return blocks;
};

/** A tar archive of `entries` in path order, terminated by two empty blocks. */
export const tarArchive = (entries: ReadonlyArray<LayerEntry>): Uint8Array => {
  const sorted = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const blocks = [...sorted.flatMap(entryBlocks), new Uint8Array(BLOCK * 2)];
  const out = new Uint8Array(blocks.reduce((size, block) => size + block.byteLength, 0));
  let offset = 0;
  for (const block of blocks) {
    out.set(block, offset);
    offset += block.byteLength;
  }
  return out;
};

/** A gzipped, digest-addressed layer of `entries`. */
export const imageLayer = (entries: ReadonlyArray<LayerEntry>): ImageLayer => {
  const tar = tarArchive(entries);
  const data = new Uint8Array(gzipSync(tar, { level: 9 }));
  return { data, digest: sha256(data), diffId: sha256(tar) };
};

const isExecutable = (mode: number) => (mode & 0o111) !== 0;

/**
 * Entries for every file, directory and symlink under `root`, placed under
 * `prefix` (e.g. `app`). Modes are normalized to 0755/0644 by the executable bit.
 */
export async function directoryEntries(root: string, prefix: string): Promise<LayerEntry[]> {
  const entries: LayerEntry[] = [{ path: `${prefix}/`, type: "directory", mode: 0o755 }];
  const walk = async (directory: string, inside: string) => {
    for (const name of (await readdir(directory)).sort()) {
      const source = join(directory, name);
      const path = `${inside}/${name}`;
      const stat = await lstat(source);
      if (stat.isSymbolicLink()) {
        entries.push({ path, type: "symlink", mode: 0o777, linkTarget: await readlink(source) });
      } else if (stat.isDirectory()) {
        entries.push({ path: `${path}/`, type: "directory", mode: 0o755 });
        await walk(source, path);
      } else if (stat.isFile()) {
        entries.push({
          path,
          type: "file",
          mode: isExecutable(stat.mode) ? 0o755 : 0o644,
          content: new Uint8Array(await readFile(source)),
        });
      }
    }
  };
  await walk(root, prefix);
  return entries;
}
