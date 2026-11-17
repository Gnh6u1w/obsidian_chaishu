import { normalizePath, TFile, Vault } from "obsidian";
import type { BookData, Dimension, NodeData, NodeType } from "./types";

/** Generate a collision-resistant id without Node/Electron APIs. */
export function uid(prefix: string): string {
  return (
    prefix +
    "-" +
    Date.now().toString(36) +
    "-" +
    Math.random().toString(36).slice(2, 8)
  );
}

/** Stable key for a cell: nodeId + "_" + dimensionId. */
export function cellKey(nodeId: string, dimensionId: string): string {
  return nodeId + "_" + dimensionId;
}

/** Remove characters that are illegal in file names across macOS/iOS/Windows. */
export function sanitizeFileName(name: string): string {
  const s = String(name ?? "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s || "未命名";
}

export function bookFolderName(title: string): string {
  const t = sanitizeFileName(title) || "未命名拆书";
  return "《" + t + "》";
}

function yamlString(s: string): string {
  const str = String(s ?? "");
  if (/[:\n"#'[\]{}&*!|>%@`]/.test(str) || str !== str.trim()) {
    return JSON.stringify(str);
  }
  return str;
}

/** Strip a leading YAML frontmatter block, returning the note body. */
export function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const firstEnd = content.indexOf("\n---", 3);
  if (firstEnd === -1) return content;
  const after = content.indexOf("\n", firstEnd + 4);
  if (after === -1) return "";
  return content.slice(after + 1);
}

// ---------------------------------------------------------------- tree ops

export function createNode(
  type: NodeType,
  name: string,
  children: NodeData[] = []
): NodeData {
  return {
    id: uid(type === "chapter" ? "c" : type === "volume" ? "v" : "u"),
    type,
    name: sanitizeFileName(name),
    summaryFile: "",
    summaryHasContent: false,
    children,
    collapsed: false,
  };
}

export function findNode(structure: NodeData[], id: string): NodeData | null {
  for (const n of structure) {
    if (n.id === id) return n;
    const r = findNode(n.children, id);
    if (r) return r;
  }
  return null;
}

/** Returns the array that directly contains `id`, or null. */
export function findParentArray(
  structure: NodeData[],
  id: string
): NodeData[] | null {
  for (const n of structure) {
    if (n.id === id) return structure;
    const r = findParentArray(n.children, id);
    if (r) return r;
  }
  return null;
}

/** Remove a node from its parent array. Returns true when removed. */
export function removeNode(structure: NodeData[], id: string): boolean {
  const arr = findParentArray(structure, id);
  if (!arr) return false;
  const idx = arr.findIndex((n) => n.id === id);
  if (idx === -1) return false;
  arr.splice(idx, 1);
  return true;
}

/** True when `ancestor` is `node` itself or an ancestor of `node`. */
export function isSelfOrDescendant(node: NodeData, ancestor: NodeData): boolean {
  if (node.id === ancestor.id) return true;
  for (const c of node.children) {
    if (isSelfOrDescendant(c, ancestor)) return true;
  }
  return false;
}

export interface NodeContext {
  volume: NodeData | null;
  unit: NodeData | null;
  node: NodeData;
}

/** Locate a node and its containing volume/unit. */
export function findNodeContext(
  structure: NodeData[],
  id: string
): NodeContext | null {
  function walk(
    nodes: NodeData[],
    volume: NodeData | null,
    unit: NodeData | null
  ): NodeContext | null {
    for (const n of nodes) {
      if (n.id === id) return { volume, unit, node: n };
      let r: NodeContext | null = null;
      if (n.type === "volume") r = walk(n.children, n, null);
      else if (n.type === "unit") r = walk(n.children, volume, n);
      if (r) return r;
    }
    return null;
  }
  return walk(structure, null, null);
}

/** Flatten chapter nodes in tree order (depth-first). */
export function collectChapters(nodes: NodeData[]): NodeData[] {
  const out: NodeData[] = [];
  function walk(list: NodeData[]): void {
    for (const n of list) {
      if (n.type === "chapter") out.push(n);
      else walk(n.children);
    }
  }
  walk(nodes);
  return out;
}

/** Flatten volume nodes in tree order. */
export function collectVolumes(nodes: NodeData[]): NodeData[] {
  const out: NodeData[] = [];
  function walk(list: NodeData[]): void {
    for (const n of list) {
      if (n.type === "volume") {
        out.push(n);
        walk(n.children);
      } else if (n.type === "unit") {
        walk(n.children);
      }
    }
  }
  walk(nodes);
  return out;
}

/** Flatten unit nodes in tree order. */
export function collectUnits(nodes: NodeData[]): NodeData[] {
  const out: NodeData[] = [];
  function walk(list: NodeData[]): void {
    for (const n of list) {
      if (n.type === "unit") {
        out.push(n);
        walk(n.children);
      } else if (n.type === "volume") {
        walk(n.children);
      }
    }
  }
  walk(nodes);
  return out;
}

// ---------------------------------------------------------------- paths

function storageBase(book: BookData): string {
  return book.storagePath ? normalizePath(book.storagePath) : "";
}

function joinVaultPath(base: string, parts: string[]): string {
  const all = [base, ...parts].filter(Boolean);
  return normalizePath(all.join("/"));
}

/** Archive path for a chapter cell note: 存放位置/《书名》/卷/单元/章节-维度.md */
export function buildChapterPath(
  book: BookData,
  chapterId: string,
  dimensionName: string
): string {
  const ctx = findNodeContext(book.structure, chapterId);
  const chapterName = ctx ? ctx.node.name : "章节";
  const parts: string[] = [bookFolderName(book.bookInfo.title)];
  if (ctx?.volume) parts.push(sanitizeFileName(ctx.volume.name));
  if (ctx?.unit) parts.push(sanitizeFileName(ctx.unit.name));
  const note = sanitizeFileName(chapterName + "-" + dimensionName) + ".md";
  parts.push(note);
  return joinVaultPath(storageBase(book), parts);
}

/** Archive path for a volume/unit summary note. */
export function buildSummaryPath(book: BookData, nodeId: string): string {
  const ctx = findNodeContext(book.structure, nodeId);
  if (!ctx || ctx.node.type === "chapter") return "";
  const parts: string[] = [bookFolderName(book.bookInfo.title)];
  if (ctx.node.type === "volume") {
    parts.push(sanitizeFileName(ctx.node.name));
    parts.push("卷总结.md");
  } else if (ctx.node.type === "unit") {
    if (ctx.volume) parts.push(sanitizeFileName(ctx.volume.name));
    parts.push(sanitizeFileName(ctx.node.name));
    parts.push("单元总结.md");
  }
  return joinVaultPath(storageBase(book), parts);
}

// ---------------------------------------------------------------- content

export function buildChapterContent(
  book: BookData,
  chapterId: string,
  dimension: Dimension,
  body: string
): string {
  const ctx = findNodeContext(book.structure, chapterId);
  const lines = [
    "---",
    "维度: " + yamlString(dimension.name),
    "章节: " + yamlString(ctx ? ctx.node.name : "章节"),
  ];
  if (ctx?.volume) lines.push("所属卷: " + yamlString(ctx.volume.name));
  if (ctx?.unit) lines.push("所属单元: " + yamlString(ctx.unit.name));
  lines.push("书名: " + yamlString(bookFolderName(book.bookInfo.title)));
  lines.push("---", "");
  const normalizedBody = body ? body.replace(/\r\n/g, "\n") : "";
  return lines.join("\n") + (normalizedBody ? normalizedBody + "\n" : "");
}

export function buildSummaryContent(
  book: BookData,
  nodeId: string,
  body: string
): string {
  const ctx = findNodeContext(book.structure, nodeId);
  const node = ctx?.node;
  const lines = ["---"];
  if (node?.type === "volume") {
    lines.push("类型: " + yamlString("卷总结"));
    lines.push("卷名: " + yamlString(node.name));
  } else if (node?.type === "unit") {
    lines.push("类型: " + yamlString("单元总结"));
    if (ctx?.volume) lines.push("所属卷: " + yamlString(ctx.volume.name));
    lines.push("单元名: " + yamlString(node.name));
  }
  lines.push("书名: " + yamlString(bookFolderName(book.bookInfo.title)));
  lines.push("---", "");
  const normalizedBody = body ? body.replace(/\r\n/g, "\n") : "";
  return lines.join("\n") + (normalizedBody ? normalizedBody + "\n" : "");
}

// ---------------------------------------------------------------- vault io

export async function ensureFolder(vault: Vault, path: string): Promise<void> {
  const normalized = normalizePath(path);
  if (!normalized || normalized === "/") return;
  if (vault.getAbstractFileByPath(normalized)) return;
  const idx = normalized.lastIndexOf("/");
  if (idx > 0) {
    await ensureFolder(vault, normalized.slice(0, idx));
  }
  try {
    await vault.createFolder(normalized);
  } catch (e) {
    if (!vault.getAbstractFileByPath(normalized)) throw e;
  }
}

/** Create (or overwrite) the chapter cell note and return the TFile. */
export async function createChapterNote(
  vault: Vault,
  book: BookData,
  chapterId: string,
  dimension: Dimension,
  body: string
): Promise<TFile> {
  const filePath = buildChapterPath(book, chapterId, dimension.name);
  const folderPath = filePath.slice(0, filePath.lastIndexOf("/"));
  await ensureFolder(vault, folderPath);
  const content = buildChapterContent(book, chapterId, dimension, body);
  const existing = vault.getAbstractFileByPath(filePath);
  if (existing instanceof TFile) {
    await vault.modify(existing, content);
    return existing;
  }
  return await vault.create(filePath, content);
}

/** Create (or overwrite) a volume/unit summary note and return the TFile. */
export async function createSummaryNote(
  vault: Vault,
  book: BookData,
  nodeId: string,
  body: string
): Promise<TFile> {
  const filePath = buildSummaryPath(book, nodeId);
  const folderPath = filePath.slice(0, filePath.lastIndexOf("/"));
  await ensureFolder(vault, folderPath);
  const content = buildSummaryContent(book, nodeId, body);
  const existing = vault.getAbstractFileByPath(filePath);
  if (existing instanceof TFile) {
    await vault.modify(existing, content);
    return existing;
  }
  return await vault.create(filePath, content);
}
