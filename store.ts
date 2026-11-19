import { normalizePath, TFile, Vault } from "obsidian";
import type { BookData, Dimension, NodeData, NodeType } from "./types";
import { DEFAULT_Y_AXIS_LABELS, EMOTION_LEVELS } from "./types";

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

// ------------------------------------------------------------- return link
// The protocol handler is registered in main.ts as "chaishu-matrix-pro".
const RETURN_MARKER = "<!-- chs-return -->";
const RETURN_LINK_MD = "[🔙 返回拆书矩阵](obsidian://chaishu-matrix-pro)";
const RETURN_FOOTER = "\n\n---\n\n" + RETURN_MARKER + "\n" + RETURN_LINK_MD + "\n";

/** Strip a previously-appended return-link footer so it never duplicates. */
export function stripReturnFooter(body: string): string {
  const idx = body.indexOf(RETURN_MARKER);
  return (idx === -1 ? body : body.slice(0, idx)).replace(/\s+$/, "");
}

/** Ensure a note ends with the return-link footer, adding it when missing.
 *  Needed for notes created by versions predating the return link (V1.5+). */
export async function ensureReturnFooter(vault: Vault, file: TFile): Promise<void> {
  let content = "";
  try {
    content = await vault.cachedRead(file);
  } catch (e) {
    return;
  }
  if (content.includes(RETURN_MARKER)) return;
  await vault.modify(file, content.replace(/\s+$/, "") + RETURN_FOOTER);
}

/** Strip a leading YAML frontmatter block (and any return-link footer), returning the note body. */
export function stripFrontmatter(content: string): string {
  let body = content;
  if (content.startsWith("---")) {
    const firstEnd = content.indexOf("\n---", 3);
    if (firstEnd !== -1) {
      const after = content.indexOf("\n", firstEnd + 4);
      body = after === -1 ? "" : content.slice(after + 1);
    }
  }
  return stripReturnFooter(body);
}

// --------------------------------------------------------- natural sorting
// Supports Arabic numerals (第2章 < 第10章), Chinese numerals (第十二章) and
// basic English number words (Chapter Two), so chapters auto-sort sensibly.

const CN_DIGITS: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};

const EN_NUM: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15,
  sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30,
  forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

function parseChineseNum(s: string): number | null {
  let total = 0;
  let section = 0;
  let num = 0;
  let any = false;
  for (const ch of s) {
    if (ch in CN_DIGITS) {
      num = CN_DIGITS[ch];
      any = true;
    } else if (ch === "十") {
      section += (num || 1) * 10;
      num = 0;
      any = true;
    } else if (ch === "百") {
      section += (num || 1) * 100;
      num = 0;
      any = true;
    } else if (ch === "千") {
      section += (num || 1) * 1000;
      num = 0;
      any = true;
    } else if (ch === "万") {
      section = (section + num) * 10000;
      total += section;
      section = 0;
      num = 0;
      any = true;
    } else {
      return null;
    }
  }
  return any ? total + section + num : null;
}

function tokenize(s: string): (string | number)[] {
  const tokens: (string | number)[] = [];
  const re = /(\d+)|([零一二两三四五六七八九十百千万]+)|([A-Za-z]+)/g;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) tokens.push(s.slice(last, m.index));
    if (m[1] !== undefined) {
      tokens.push(parseInt(m[1], 10));
    } else if (m[2] !== undefined) {
      const cn = parseChineseNum(m[2]);
      tokens.push(cn ?? m[2]);
    } else if (m[3] !== undefined) {
      const en = EN_NUM[m[3].toLowerCase()];
      tokens.push(en ?? m[3]);
    }
    last = m.index + m[0].length;
  }
  if (last < s.length) tokens.push(s.slice(last));
  return tokens;
}

/** Natural-order comparator for node names (chapter names in particular). */
export function naturalCompare(a: string, b: string): number {
  const ta = tokenize(String(a));
  const tb = tokenize(String(b));
  const n = Math.max(ta.length, tb.length);
  for (let i = 0; i < n; i++) {
    const x = ta[i];
    const y = tb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === "number" && typeof y === "number") {
      if (x !== y) return x - y;
    } else {
      const c = String(x).localeCompare(String(y), "zh-Hans-CN", { numeric: true, sensitivity: "base" });
      if (c !== 0) return c;
    }
  }
  return 0;
}

/** Stable-sort only the chapter siblings within an array (containers keep their positions). */
export function sortChapterSiblings(arr: NodeData[]): void {
  const idxs: number[] = [];
  arr.forEach((n, i) => {
    if (n.type === "chapter") idxs.push(i);
  });
  const chapters = idxs.map((i) => arr[i]).sort((a, b) => naturalCompare(a.name, b.name));
  idxs.forEach((idx, k) => {
    arr[idx] = chapters[k];
  });
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
    summaryFiles: {},
    children,
    collapsed: false,
    hideContent: false,
    emotionData: [],
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

/** Chapters not yet collected into a unit (top-level or directly under a volume). */
export function collectUncollectedChapters(nodes: NodeData[]): NodeData[] {
  const out: NodeData[] = [];
  function walk(list: NodeData[], insideUnit: boolean): void {
    for (const n of list) {
      if (n.type === "chapter") {
        if (!insideUnit) out.push(n);
      } else {
        walk(n.children, n.type === "unit");
      }
    }
  }
  walk(nodes, false);
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
    "拆书项目: " + yamlString(bookFolderName(book.bookInfo.title)),
  ];
  if (ctx?.volume) lines.push("所属卷: " + yamlString(ctx.volume.name));
  if (ctx?.unit) lines.push("所属单元: " + yamlString(ctx.unit.name));
  lines.push("章节名称: " + yamlString(ctx ? ctx.node.name : "章节"));
  lines.push("分析维度: " + yamlString(dimension.name));
  lines.push("---", "");
  const normalizedBody = stripReturnFooter(body ? body.replace(/\r\n/g, "\n") : "");
  return lines.join("\n") + (normalizedBody ? normalizedBody + "\n" : "") + RETURN_FOOTER;
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
  lines.push("拆书项目: " + yamlString(bookFolderName(book.bookInfo.title)));
  lines.push("---", "");
  const normalizedBody = stripReturnFooter(body ? body.replace(/\r\n/g, "\n") : "");
  return lines.join("\n") + (normalizedBody ? normalizedBody + "\n" : "") + RETURN_FOOTER;
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

/** Normalize a raw value into exactly 5 emotion Y-axis labels. */
export function normalizeYAxisLabels(labels: unknown): string[] {
  const out: string[] = [];
  const src = Array.isArray(labels) ? labels : [];
  for (let i = 0; i < EMOTION_LEVELS; i++) {
    const v = src[i];
    out.push(typeof v === "string" && v.trim() ? v.trim() : DEFAULT_Y_AXIS_LABELS[i]);
  }
  return out;
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

// ---------------------------------------------- per-dimension summaries (V2.0)

/** Archive path for a per-dimension volume/unit summary note:
 *  存放位置/《书名》/第X卷总结-维度.md  (flat under the book folder). */
export function buildSummaryDimPath(
  book: BookData,
  nodeId: string,
  dimensionName: string
): string {
  const ctx = findNodeContext(book.structure, nodeId);
  if (!ctx || ctx.node.type === "chapter") return "";
  const parts: string[] = [bookFolderName(book.bookInfo.title)];
  parts.push(sanitizeFileName(ctx.node.name + "总结-" + dimensionName) + ".md");
  return joinVaultPath(storageBase(book), parts);
}

/** YAML + return footer for a per-dimension volume/unit summary note. */
export function buildSummaryDimContent(
  book: BookData,
  nodeId: string,
  dimension: Dimension,
  body: string
): string {
  const ctx = findNodeContext(book.structure, nodeId);
  const node = ctx?.node;
  const lines = ["---"];
  if (node?.type === "volume") {
    lines.push("类型: " + yamlString("卷总结"));
    lines.push("所属卷: " + yamlString(node.name));
  } else if (node?.type === "unit") {
    lines.push("类型: " + yamlString("单元总结"));
    if (ctx?.volume) lines.push("所属卷: " + yamlString(ctx.volume.name));
    lines.push("单元名: " + yamlString(node.name));
  }
  lines.push("维度: " + yamlString(dimension.name));
  lines.push("拆书项目: " + yamlString(bookFolderName(book.bookInfo.title)));
  lines.push("---", "");
  const normalizedBody = stripReturnFooter(body ? body.replace(/\r\n/g, "\n") : "");
  return lines.join("\n") + (normalizedBody ? normalizedBody + "\n" : "") + RETURN_FOOTER;
}

/** Create (or overwrite) a per-dimension volume/unit summary note. */
export async function createSummaryDimNote(
  vault: Vault,
  book: BookData,
  nodeId: string,
  dimension: Dimension,
  body: string
): Promise<TFile> {
  const filePath = buildSummaryDimPath(book, nodeId, dimension.name);
  const folderPath = filePath.slice(0, filePath.lastIndexOf("/"));
  await ensureFolder(vault, folderPath);
  const content = buildSummaryDimContent(book, nodeId, dimension, body);
  const existing = vault.getAbstractFileByPath(filePath);
  if (existing instanceof TFile) {
    await vault.modify(existing, content);
    return existing;
  }
  return await vault.create(filePath, content);
}
