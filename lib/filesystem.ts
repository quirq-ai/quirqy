import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Entry, FileView, PreviewResult, WorkspaceSnapshot } from "./types";

export const MAX_TEXT_BYTES = 2 * 1024 * 1024;
export const MAX_PREVIEW_BYTES = 20 * 1024 * 1024;
export const MAX_DIRECTORY_ENTRIES = 2_000;

const OMITTED_NAMES = new Set(["node_modules"]);
const TEXT_EXTENSIONS = new Set([
  "txt", "text", "csv", "tsv", "log", "js", "jsx", "ts", "tsx", "mjs", "cjs",
  "jsonc", "css", "scss", "sass", "less", "html", "htm", "xml", "svg", "yaml",
  "yml", "toml", "ini", "conf", "config", "sql", "py", "rb", "rs", "go", "java",
  "kt", "kts", "swift", "sh", "bash", "zsh", "fish", "ps1", "bat", "c", "cpp",
  "cc", "h", "hpp", "cs", "vue", "svelte", "astro", "prisma", "graphql", "gql",
  "proto", "diff", "patch", "r", "rmd", "tex", "dockerfile", "lock",
]);
const TEXT_NAMES = new Set(["dockerfile", "makefile", "license", "readme", "changelog"]);
const IMAGE_MIME = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
]);

export class MirrorError extends Error {
  constructor(message: string, public readonly status: number = 400) {
    super(message);
    this.name = "MirrorError";
  }
}

function isVisibleName(name: string): boolean {
  return !name.startsWith(".") && !OMITTED_NAMES.has(name) && !name.includes("\\") && !name.includes(":");
}

/** Do not normalize traversal away: a rejected path must stay rejected. */
function relativePath(requestedPath: string): string {
  if (
    requestedPath.includes("\0") ||
    requestedPath.includes("\\") ||
    requestedPath.includes(":") ||
    path.posix.isAbsolute(requestedPath) ||
    path.win32.isAbsolute(requestedPath)
  ) {
    throw new MirrorError("Use a relative path inside the workspace.");
  }
  const components = requestedPath.split("/").filter(Boolean);
  if (components.some((part) => part === "." || part === "..")) {
    throw new MirrorError("Path traversal is not allowed.");
  }
  if (components.some((part) => !isVisibleName(part))) {
    throw new MirrorError("Hidden files and dependency folders are not available.", 403);
  }
  return components.join("/");
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new MirrorError("This path leaves the workspace.", 403);
  }
  // A visible symlink must not expose an otherwise hidden file or dependency.
  if (relative && relative.split(path.sep).some((part) => !isVisibleName(part))) {
    throw new MirrorError("Hidden files and dependency folders are not available.", 403);
  }
}

async function workspaceRoot(configuredRoot?: string): Promise<string> {
  const configured = configuredRoot ?? process.env.MIRROR_ROOT;
  const root = await realpath(path.resolve(configured || path.join(process.cwd(), "workspace")));
  if (!(await stat(root)).isDirectory()) {
    throw new MirrorError("The configured workspace must be a folder.", 400);
  }
  return root;
}

/** Resolve a selectable directory using the same traversal and symlink boundary as file reads. */
export async function resolveObservationDirectory(relative: string, configuredRoot?: string): Promise<string> {
  const root = await workspaceRoot(configuredRoot);
  const resolved = await resolveInside(root, relativePath(relative));
  if (!(await stat(resolved)).isDirectory()) throw new MirrorError("Choose a folder, not a file.");
  return resolved;
}

async function resolveInside(root: string, relative: string): Promise<string> {
  const resolved = await realpath(path.join(root, relative));
  assertContained(root, resolved);
  return resolved;
}

function makeEntry(relative: string, metadata: Stats): Entry {
  const name = path.posix.basename(relative);
  const isDirectory = metadata.isDirectory();
  return {
    name,
    path: relative,
    kind: isDirectory ? "directory" : "file",
    extension: isDirectory ? "" : path.posix.extname(name).slice(1).toLowerCase(),
    size: isDirectory ? 0 : metadata.size,
    modifiedAt: metadata.mtime.toISOString(),
  };
}

async function listDirectory(root: string, relative: string): Promise<Entry[]> {
  const resolved = await resolveInside(root, relative);
  const children = (await readdir(resolved, { withFileTypes: true })).filter((entry) => isVisibleName(entry.name));
  if (children.length > MAX_DIRECTORY_ENTRIES) {
    throw new MirrorError(`This folder contains more than ${MAX_DIRECTORY_ENTRIES.toLocaleString("en-US")} entries. Choose a smaller workspace folder.`, 413);
  }
  const entries = await Promise.all(children.map(async (child): Promise<Entry | null> => {
    const childRelative = relative ? `${relative}/${child.name}` : child.name;
    try {
      const childResolved = await resolveInside(root, childRelative);
      const metadata = await stat(childResolved);
      // Named pipes, devices, and sockets must never be treated as ordinary files.
      if (!metadata.isDirectory() && !metadata.isFile()) return null;
      return makeEntry(childRelative, metadata);
    } catch (error) {
      // An external or hidden-target symlink is not part of the visible workspace.
      // Files deleted between readdir and stat disappear on this refresh.
      if (error instanceof MirrorError && error.status === 403) return null;
      if (["ENOENT", "ENOTDIR", "ELOOP"].includes(errorCode(error))) return null;
      throw error;
    }
  }));
  return entries.filter((entry): entry is Entry => entry !== null).sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1;
    return left.name.localeCompare(right.name, "en", { numeric: true, sensitivity: "base" }) || left.name.localeCompare(right.name, "en");
  });
}

/** Bound reads even if another process grows a file while it is being read. */
async function readLimitedBytes(resolved: string, limit: number): Promise<Buffer> {
  // Nonblocking open prevents a misleading .png named pipe from hanging the route
  // before fstat can reject it. Regular files ignore this flag.
  const handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) throw new MirrorError("Only regular files can be opened.", 400);
    if (metadata.size > limit) throw new MirrorError("This file exceeds the preview size limit.", 413);
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= limit) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit + 1 - total));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > limit) throw new MirrorError("This file exceeds the preview size limit.", 413);
    return Buffer.concat(chunks, total);
  } finally {
    await handle.close();
  }
}

function fileFormat(entry: Entry): FileView["format"] {
  if (["jsonl", "ndjson"].includes(entry.extension)) return "jsonl";
  if (entry.extension === "url") return "url";
  if (entry.extension === "json") return "json";
  if (["md", "markdown", "mdx"].includes(entry.extension)) return "markdown";
  if (IMAGE_MIME.has(entry.extension)) return "image";
  if (entry.extension === "pdf") return "pdf";
  if (TEXT_EXTENSIONS.has(entry.extension) || TEXT_NAMES.has(entry.name.toLowerCase())) return "text";
  return "unsupported";
}

async function loadFile(root: string, relative: string, metadata: Stats): Promise<FileView> {
  const entry = makeEntry(relative, metadata);
  const format = fileFormat(entry);
  const view: FileView = { ...entry, kind: "file", format };
  if (format === "unsupported") {
    return { ...view, error: "This file type has no preview. Its name and details are still mirrored from disk." };
  }
  if (format === "image" || format === "pdf") {
    return entry.size > MAX_PREVIEW_BYTES
      ? { ...view, error: "This file is larger than the 20 MB preview limit." }
      : view;
  }
  if (entry.size > MAX_TEXT_BYTES) return { ...view, error: "This file is larger than the 2 MB text preview limit." };
  let bytes: Buffer;
  try {
    bytes = await readLimitedBytes(await resolveInside(root, relative), MAX_TEXT_BYTES);
  } catch (error) {
    if (error instanceof MirrorError && error.status === 413) {
      return { ...view, error: "This file is larger than the 2 MB text preview limit." };
    }
    throw error;
  }
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (content.includes("\0")) throw new Error("Binary text");
  } catch {
    return { ...view, format: "unsupported", error: "This file contains binary data or text that is not UTF-8." };
  }
  if (format === "json") {
    try {
      return { ...view, content, data: JSON.parse(content) as unknown };
    } catch {
      return { ...view, content, error: "This JSON is not valid yet. The original file contents are shown below." };
    }
  }
  return { ...view, content };
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error ? String(error.code) : "";
}

/** All externally visible errors are deliberately free of absolute disk paths. */
export function safeMirrorError(error: unknown): MirrorError {
  if (error instanceof MirrorError) return error;
  if (["ENOENT", "ENOTDIR"].includes(errorCode(error))) {
    return new MirrorError("The requested file or folder was not found.", 404);
  }
  if (["EACCES", "EPERM"].includes(errorCode(error))) {
    return new MirrorError("This file or folder cannot be read.", 403);
  }
  if (errorCode(error) === "ELOOP") return new MirrorError("This symbolic link cannot be opened.", 403);
  return new MirrorError("The workspace could not be read.", 500);
}

export async function loadWorkspace(requestedPath = "", configuredRoot?: string): Promise<WorkspaceSnapshot> {
  try {
    const relative = relativePath(requestedPath);
    const root = await workspaceRoot(configuredRoot);
    const resolved = await resolveInside(root, relative);
    const metadata = await stat(resolved);
    if (!metadata.isFile() && !metadata.isDirectory()) throw new MirrorError("Only files and folders can be opened.", 400);
    const isFile = metadata.isFile();
    const directoryPath = isFile ? (path.posix.dirname(relative) === "." ? "" : path.posix.dirname(relative)) : relative;
    const rootEntries = await listDirectory(root, "");
    const entries = directoryPath === "" ? rootEntries : await listDirectory(root, directoryPath);
    const rootName = path.basename(root) || "Workspace";
    const snapshot: Omit<WorkspaceSnapshot, "revision"> = {
      rootName,
      rootId: createHash("sha256").update(root).digest("hex"),
      roots: rootEntries.filter((entry) => entry.kind === "directory"),
      directory: {
        path: directoryPath,
        name: directoryPath ? path.posix.basename(directoryPath) : rootName,
        entries,
      },
      ...(isFile ? { file: await loadFile(root, relative, metadata) } : {}),
    };
    // Content participates in the digest; same-size or preserved-mtime edits refresh.
    const revision = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
    return { ...snapshot, revision };
  } catch (error) {
    throw safeMirrorError(error);
  }
}

function matchesMime(bytes: Buffer, contentType: string): boolean {
  if (contentType === "image/png") return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (contentType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (contentType === "image/gif") return ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii"));
  if (contentType === "image/webp") return bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";
  if (contentType === "application/pdf") return bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  return false;
}

export async function readPreview(requestedPath: string, configuredRoot?: string): Promise<PreviewResult> {
  try {
    const relative = relativePath(requestedPath);
    if (!relative) throw new MirrorError("Choose a file to preview.", 400);
    const root = await workspaceRoot(configuredRoot);
    const resolved = await resolveInside(root, relative);
    const extension = path.posix.extname(relative).slice(1).toLowerCase();
    const contentType = IMAGE_MIME.get(extension) ?? (extension === "pdf" ? "application/pdf" : undefined);
    if (!contentType) throw new MirrorError("Only supported images and PDF files have a binary preview.", 415);
    const bytes = await readLimitedBytes(resolved, MAX_PREVIEW_BYTES);
    if (!matchesMime(bytes, contentType)) throw new MirrorError("The file contents do not match this preview format.", 415);
    return { bytes: new Uint8Array(bytes), contentType, name: path.posix.basename(relative) };
  } catch (error) {
    throw safeMirrorError(error);
  }
}
