export const VIEW_TYPE_CHAISHU_MATRIX = "chaishu-matrix-pro-view";

export interface Dimension {
  id: string;
  name: string;
  color: string;
}

export interface BookInfo {
  title: string;
  author: string;
  score: string;
}

export interface CellData {
  /** Vault-relative path of the note, "" when not created yet. */
  filePath: string;
  hasContent: boolean;
}

export interface BookData {
  id: string;
  bookInfo: BookInfo;
  dimensions: Dimension[];
  chapters: string[];
  cells: Record<string, CellData>;
}

export interface ChaiShuSettings {
  defaultChapterCount: number;
  defaultDimensionNames: string;
  activeBookId: string;
  books: BookData[];
}

export const DEFAULT_SETTINGS: ChaiShuSettings = {
  defaultChapterCount: 5,
  defaultDimensionNames: "长期期待,中期期待,情绪,冲突",
  activeBookId: "",
  books: [],
};

export const DIMENSION_COLORS: string[] = [
  "#3b82f6", // blue
  "#f97316", // orange
  "#ef4444", // red
  "#22c55e", // green
  "#a855f7", // purple
  "#ec4899", // pink
  "#14b8a6", // teal
  "#eab308", // yellow
];

export const DIMENSION_COLOR_NAMES: string[] = [
  "蓝",
  "橙",
  "红",
  "绿",
  "紫",
  "粉",
  "青",
  "黄",
];
