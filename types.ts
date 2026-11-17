export const VIEW_TYPE_CHAISHU_MATRIX = "chaishu-matrix-pro-view";

export type NodeType = "volume" | "unit" | "chapter";

export interface Dimension {
  id: string;
  name: string;
  color: string;
  /** When true, this dimension exposes the emotion-chart drawing. */
  isChart: boolean;
  /** 5 labels for the emotion Y-axis (from lowest to highest). */
  yAxisLabels: string[];
}

export interface NodeData {
  id: string;
  type: NodeType;
  name: string;
  /** Vault-relative path of the volume/unit summary note, "" when not created. */
  summaryFile: string;
  summaryHasContent: boolean;
  children: NodeData[];
  collapsed: boolean;
}

export interface BookInfo {
  title: string;
  author: string;
  score: string;
  /** Vault-relative path of the wallpaper image, "" = none. */
  bgImage: string;
  bgMode: "cover" | "repeat";
  /** Overlay opacity 0..1 (higher = darker mask). */
  bgOverlay: number;
}

export interface CellData {
  /** Vault-relative path of the note, "" when not created yet. */
  filePath: string;
  hasContent: boolean;
}

export interface EmotionPoint {
  /** Plot progress 0..100. */
  x: number;
  /** Emotion level 1..5 (1 = lowest, 5 = highest). */
  y: number;
}

export interface BookData {
  id: string;
  bookInfo: BookInfo;
  /** Vault-relative base directory for archiving, "" = vault root. */
  storagePath: string;
  dimensions: Dimension[];
  structure: NodeData[];
  cells: Record<string, CellData>;
  /** Emotion points per chapter id (the emotion chart is per-book). */
  chapterEmotions: Record<string, EmotionPoint[]>;
}

export interface ImportRequest {
  sourceType: "external" | "vault";
  sourceName: string;
  /** File text content (external import only). */
  content?: string;
  /** Vault-relative path (vault import only). */
  vaultPath?: string;
  chapterId: string;
  dimensionId: string;
  /** Move the vault note into the book folder (vault import only). */
  move: boolean;
}

export interface ChaiShuSettings {
  defaultChapterCount: number;
  defaultDimensionNames: string;
  defaultStoragePath: string;
  activeBookId: string;
  books: BookData[];
}

export const DEFAULT_SETTINGS: ChaiShuSettings = {
  defaultChapterCount: 5,
  defaultDimensionNames: "情绪,长期期待,中期期待,冲突",
  defaultStoragePath: "",
  activeBookId: "",
  books: [],
};

export const EMOTION_LEVELS = 5;

export const DEFAULT_Y_AXIS_LABELS: string[] = [
  "极差",
  "低落",
  "平稳",
  "高昂",
  "极好",
];

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
