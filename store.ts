import { normalizePath, TFile, Vault } from "obsidian";
import type { BookData, Dimension } from "./types";

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

/** Stable key for a cell: chapter + "_" + dimensionId. */
export function cellKey(chapter: string, dimensionId: string): string {
  return chapter + "_" + dimensionId;
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

export function buildNoteContent(
  book: BookData,
  chapter: string,
  dimension: Dimension,
  body: string
): string {
  const lines = [
    "---",
    "维度: " + yamlString(dimension.name),
    "章节: " + yamlString(chapter),
    "书名: " + yamlString(bookFolderName(book.bookInfo.title)),
    "---",
    "",
  ];
  const normalizedBody = body ? body.replace(/\r\n/g, "\n") : "";
  return lines.join("\n") + (normalizedBody ? normalizedBody + "\n" : "");
}

/** Vault-relative archive path: 《书名》/第X章/第X章-维度名.md */
export function buildCellPath(
  book: BookData,
  chapter: string,
  dimension: Dimension
): string {
  const folder = bookFolderName(book.bookInfo.title);
  const chapterFolder = sanitizeFileName(chapter);
  const noteName = sanitizeFileName(chapter + "-" + dimension.name);
  return normalizePath(folder + "/" + chapterFolder + "/" + noteName + ".md");
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

/** Recursively ensure a folder path exists inside the vault. */
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

/** Create (or overwrite) the note for a cell and return the TFile. */
export async function createCellNote(
  vault: Vault,
  book: BookData,
  chapter: string,
  dimension: Dimension,
  body: string
): Promise<TFile> {
  const filePath = buildCellPath(book, chapter, dimension);
  const folderPath = filePath.slice(0, filePath.lastIndexOf("/"));
  await ensureFolder(vault, folderPath);
  const content = buildNoteContent(book, chapter, dimension, body);
  const existing = vault.getAbstractFileByPath(filePath);
  if (existing instanceof TFile) {
    await vault.modify(existing, content);
    return existing;
  }
  return await vault.create(filePath, content);
}
