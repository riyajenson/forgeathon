export type SourceRange = { startLine: number; endLine: number }; // 1-based inclusive
export type SymbolLocation = SourceRange & { path: string; name: string };
export type Reference = { kind: 'file'; path: string } | { kind: 'symbol'; name: string };
export type PromptContext = {
  activeFile?: string;
  selection?: SourceRange & { path: string; text: string };
  references?: readonly Reference[];
};
export type ContextReport = {
  budgetTokens: number;
  estimatedTokens: number;
  skipped: readonly { path: string; reason: string; estimatedTokens: number }[];
  selections: readonly {
    path: string;
    symbol?: string;
    range?: SourceRange;
    source: 'active' | 'selection' | 'explicit' | 'automatic';
    rank: number;
    rationale: string;
    estimatedTokens: number;
    truncated: boolean;
  }[];
};
