import {
  normalizePath,
  parseYaml,
  TAbstractFile,
  TFile,
  TFolder,
  Vault,
} from "obsidian";
import type {
  BookData,
  CellData,
  CharacterData,
  Dimension,
  NodeData,
  NodeType,
} from "./types";
import {
  DEFAULT_Y_AXIS_LABELS,
  DIMENSION_COLORS,
  EMOTION_LEVELS,
} from "./types";

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
// Character-note return link → 人设拆解 view (protocol "chaishu-character" in main.ts).
const CHARACTER_RETURN_LINK_MD = "[🔙 返回人设拆解](obsidian://chaishu-character)";
const CHARACTER_RETURN_FOOTER = "\n\n---\n\n" + RETURN_MARKER + "\n" + CHARACTER_RETURN_LINK_MD + "\n";

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

// -------------------------------------------------- 人设拆解 notes (V2.1)

/** Archive path for a character dimension note:
 *  存放位置/《书名》/《人设》/<角色名>-<人设维度>.md */
export function buildCharacterPath(
  book: BookData,
  characterId: string,
  dimensionName: string
): string {
  const character = book.characters.find((c) => c.id === characterId);
  const name = character?.name ?? "角色";
  const parts: string[] = [
    bookFolderName(book.bookInfo.title),
    "《人设》",
    sanitizeFileName(name + "-" + dimensionName) + ".md",
  ];
  return joinVaultPath(storageBase(book), parts);
}

/** YAML + character return footer for a character dimension note. */
export function buildCharacterContent(
  book: BookData,
  characterId: string,
  dimension: Dimension,
  body: string
): string {
  const character = book.characters.find((c) => c.id === characterId);
  const lines = [
    "---",
    "类型: " + yamlString("人设"),
    "角色名称: " + yamlString(character?.name ?? "角色"),
    "人设维度: " + yamlString(dimension.name),
    "拆书项目: " + yamlString(bookFolderName(book.bookInfo.title)),
    // V2.3: auto-tag so the note shows in Obsidian's native graph filtered by 人设/书名.
    "tags: " + JSON.stringify(["人设", bookFolderName(book.bookInfo.title)]),
    "---",
    "",
  ];
  const normalizedBody = stripReturnFooter(body ? body.replace(/\r\n/g, "\n") : "");
  return lines.join("\n") + (normalizedBody ? normalizedBody + "\n" : "") + CHARACTER_RETURN_FOOTER;
}

/** Create (or overwrite) a character dimension note and return the TFile. */
export async function createCharacterNote(
  vault: Vault,
  book: BookData,
  characterId: string,
  dimension: Dimension,
  body: string
): Promise<TFile> {
  const filePath = buildCharacterPath(book, characterId, dimension.name);
  const folderPath = filePath.slice(0, filePath.lastIndexOf("/"));
  await ensureFolder(vault, folderPath);
  const content = buildCharacterContent(book, characterId, dimension, body);
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

// ------------------------------------------------------- note recovery (V2.3)
// Rebuild BookData[] from a folder of already-existing notes by parsing their
// YAML frontmatter (拆书项目/所属卷/所属单元/章节名称/分析维度 …). Tolerant of
// missing/misspelled keys: falls back to English keys and strips 《》 brackets.

function cleanRecoveredTitle(t: string): string {
  return t.replace(/^《/, "").replace(/》$/, "").trim();
}

function extractRecoveredFrontmatter(
  content: string
): Record<string, unknown> | null {
  const m = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  try {
    const parsed = parseYaml(m[1]);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

interface RecoveredNote {
  file: TFile;
  book: string;
  type: string;
  volume: string;
  unit: string;
  chapter: string;
  dimension: string;
  character: string;
  charDimension: string;
}

/** Scan a vault folder recursively and rebuild books from note YAML. */
export async function recoverBooksFromFolder(
  vault: Vault,
  folderPath: string
): Promise<BookData[]> {
  const folder = vault.getAbstractFileByPath(normalizePath(folderPath));
  if (!(folder instanceof TFolder)) return [];

  const files: TFile[] = [];
  const collect = (f: TAbstractFile): void => {
    if (f instanceof TFolder) {
      for (const c of f.children) collect(c);
    } else if (f instanceof TFile && f.extension.toLowerCase() === "md") {
      files.push(f);
    }
  };
  collect(folder);

  const notes: RecoveredNote[] = [];
  for (const f of files) {
    let content = "";
    try {
      content = await vault.cachedRead(f);
    } catch {
      continue;
    }
    const fm = extractRecoveredFrontmatter(content);
    if (!fm) continue;
    const str = (k: string): string => {
      const v = fm[k];
      return v == null ? "" : String(v).trim();
    };
    const book = cleanRecoveredTitle(
      str("拆书项目") || str("book") || str("书名")
    );
    if (!book) continue;
    notes.push({
      file: f,
      book,
      type: str("类型") || str("type"),
      volume: str("所属卷") || str("卷名") || str("volume"),
      unit: str("所属单元") || str("单元名") || str("unit"),
      chapter: str("章节名称") || str("chapter") || str("章节"),
      dimension: str("分析维度") || str("dimension") || str("维度"),
      character: str("角色名称") || str("character"),
      charDimension: str("人设维度") || str("characterDimension"),
    });
  }

  const byBook = new Map<string, RecoveredNote[]>();
  for (const n of notes) {
    const arr = byBook.get(n.book) || [];
    arr.push(n);
    byBook.set(n.book, arr);
  }

  const books: BookData[] = [];
  for (const [title, ns] of byBook) {
    const b = buildRecoveredBook(title, ns);
    if (b) books.push(b);
  }
  return books;
}

function buildRecoveredBook(
  title: string,
  notes: RecoveredNote[]
): BookData | null {
  const chapterNotes = notes.filter((n) => n.chapter && n.dimension);
  if (chapterNotes.length === 0) return null;

  // Dimensions (unique, first-appearance order).
  const dimIdByName = new Map<string, string>();
  const dimensions: Dimension[] = [];
  for (const n of chapterNotes) {
    if (!dimIdByName.has(n.dimension)) {
      const id = uid("d");
      dimIdByName.set(n.dimension, id);
      dimensions.push({
        id,
        name: n.dimension,
        color: DIMENSION_COLORS[dimensions.length % DIMENSION_COLORS.length],
        isChart: n.dimension === "情绪",
        yAxisLabels: [...DEFAULT_Y_AXIS_LABELS],
      });
    }
  }

  // Structure: volumes → units → chapters (plus top-level chapters).
  const structure: NodeData[] = [];
  const volByName = new Map<string, NodeData>();
  const unitByName = new Map<string, NodeData>(); // key = "volume|unit"
  const chapterByKey = new Map<string, NodeData>();
  const cells: Record<string, CellData> = {};

  const getVolume = (name: string): NodeData => {
    let v = volByName.get(name);
    if (!v) {
      v = createNode("volume", name);
      volByName.set(name, v);
      structure.push(v);
    }
    return v;
  };
  const getUnit = (name: string, volumeName: string): NodeData => {
    const key = volumeName + "|" + name;
    let u = unitByName.get(key);
    if (!u) {
      u = createNode("unit", name);
      unitByName.set(key, u);
      if (volumeName) getVolume(volumeName).children.push(u);
      else structure.push(u);
    }
    return u;
  };

  for (const n of chapterNotes) {
    const key = n.volume + "|" + n.unit + "|" + n.chapter;
    let c = chapterByKey.get(key);
    if (!c) {
      c = createNode("chapter", n.chapter);
      chapterByKey.set(key, c);
      if (n.volume) {
        const vol = getVolume(n.volume);
        if (n.unit) getUnit(n.unit, n.volume).children.push(c);
        else vol.children.push(c);
      } else if (n.unit) {
        getUnit(n.unit, "").children.push(c);
      } else {
        structure.push(c);
      }
    }
    const dimId = dimIdByName.get(n.dimension);
    if (dimId) {
      cells[cellKey(c.id, dimId)] = {
        filePath: n.file.path,
        hasContent: true,
      };
    }
  }

  // Per-dimension summary notes.
  for (const n of notes) {
    if (n.type !== "卷总结" && n.type !== "单元总结") continue;
    const dimId = n.dimension ? dimIdByName.get(n.dimension) : undefined;
    if (!dimId) continue;
    if (n.type === "卷总结" && n.volume) {
      const v = volByName.get(n.volume);
      if (v) v.summaryFiles[dimId] = n.file.path;
    } else if (n.type === "单元总结" && n.unit) {
      const u =
        unitByName.get(n.volume + "|" + n.unit) || unitByName.get("|" + n.unit);
      if (u) u.summaryFiles[dimId] = n.file.path;
    }
  }

  // Character notes (人设拆解).
  const characters: CharacterData[] = [];
  const charByName = new Map<string, CharacterData>();
  const charDimIdByName = new Map<string, string>();
  const characterDimensions: Dimension[] = [];
  const characterCells: Record<string, CellData> = {};

  for (const n of notes) {
    if (n.type !== "人设" || !n.character || !n.charDimension) continue;
    let c = charByName.get(n.character);
    if (!c) {
      c = { id: uid("char"), name: n.character, factionId: "" };
      charByName.set(n.character, c);
      characters.push(c);
    }
    let dimId = charDimIdByName.get(n.charDimension);
    if (!dimId) {
      dimId = uid("d");
      charDimIdByName.set(n.charDimension, dimId);
      characterDimensions.push({
        id: dimId,
        name: n.charDimension,
        color: DIMENSION_COLORS[characterDimensions.length % DIMENSION_COLORS.length],
        isChart: false,
        yAxisLabels: [],
      });
    }
    characterCells[cellKey(c.id, dimId)] = {
      filePath: n.file.path,
      hasContent: true,
    };
  }

  return {
    id: uid("book"),
    bookInfo: {
      title,
      author: "",
      score: "",
      category: [],
      tags: [],
      bgImage: "",
      bgMode: "cover",
      bgOverlay: 0.3,
    },
    storagePath: "",
    dimensions,
    structure,
    cells,
    characters,
    characterDimensions,
    characterCells,
    factions: [],
    relationships: [],
  };
}
