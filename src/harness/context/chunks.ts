// Splits files into retrieval units: Python functions/classes (with decorators), doc sections, or windows.

export interface Chunk {
  path: string;
  /** 1-based inclusive. */
  startLine: number;
  endLine: number;
  kind: 'function' | 'class' | 'module' | 'section' | 'window';
  /** Simple name (functions, classes, sections). */
  name?: string;
  /** Qualified Python name, e.g. FlaskGroup.list_commands. */
  qualname?: string;
  /** First line of the definition, used in outlines. */
  signature?: string;
  /** Decorator lines, e.g. "@click.command(\"routes\", short_help=...)". */
  decorators?: string[];
  text: string;
}

const DEF_RE = /^(\s*)(async\s+def|def|class)\s+([A-Za-z_]\w*)/;
const WINDOW = 80;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** Python: one chunk per def/class (classes cover only their header up to the first method), plus module-level code. */
export function chunkPython(path: string, text: string): Chunk[] {
  const lines = text.split(/\r?\n/);
  const chunks: Chunk[] = [];
  const covered = new Array<boolean>(lines.length).fill(false);
  const stack: Array<{ indent: number; name: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    const m = DEF_RE.exec(lines[i]!);
    if (!m) continue;
    const indent = m[1]!.length;
    const kind = m[2] === 'class' ? 'class' : 'function';
    const name = m[3]!;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const qualname = [...stack.map((s) => s.name), name].join('.');

    // Decorators directly above, including multi-line decorator calls (continuation lines are deeper).
    let start = i;
    const decorators: string[] = [];
    for (let k = i - 1; k >= 0; k--) {
      const l = lines[k]!;
      if (l.trim() === '') break;
      const ind = indentOf(l);
      if (ind > indent || (ind === indent && /^\s*[)\]]/.test(l))) continue; // continuation of a decorator call
      if (ind === indent && l.trimStart().startsWith('@')) {
        start = k;
        decorators.unshift(l.trim());
        continue;
      }
      break;
    }

    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!;
      if (l.trim() === '' || l.trimStart().startsWith('#')) continue;
      if (indentOf(l) <= indent) break;
      end = j;
    }
    let bodyEnd = end;
    if (kind === 'class') {
      for (let j = i + 1; j <= end; j++) {
        const inner = DEF_RE.exec(lines[j]!);
        if (inner && inner[1]!.length > indent) {
          let k = j;
          while (k > i + 1 && /^\s*@/.test(lines[k - 1]!)) k--;
          bodyEnd = Math.max(i, k - 1);
          break;
        }
      }
    }
    for (let k = start; k <= end; k++) covered[k] = true;
    chunks.push({
      path, kind, name, qualname,
      startLine: start + 1,
      endLine: bodyEnd + 1,
      signature: lines[i]!.trim(),
      ...(decorators.length ? { decorators } : {}),
      text: lines.slice(start, bodyEnd + 1).join('\n'),
    });
    stack.push({ indent, name });
  }

  // Module-level code (imports, registrations, constants) in runs of uncovered lines.
  let runStart = -1;
  const flush = (endIdx: number) => {
    if (runStart < 0) return;
    const body = lines.slice(runStart, endIdx + 1);
    if (body.some((l) => l.trim() !== '')) {
      for (let s = 0; s < body.length; s += WINDOW) {
        const part = body.slice(s, s + WINDOW);
        if (part.some((l) => l.trim() !== '')) {
          chunks.push({ path, kind: 'module', startLine: runStart + s + 1, endLine: runStart + s + part.length, text: part.join('\n') });
        }
      }
    }
    runStart = -1;
  };
  for (let i = 0; i < lines.length; i++) {
    if (!covered[i]) { if (runStart < 0) runStart = i; } else flush(i - 1);
  }
  flush(lines.length - 1);
  return chunks.sort((a, b) => a.startLine - b.startLine);
}

const RST_UNDERLINE = /^([=\-~^"'`#*+])\1{2,}\s*$/;

/** reStructuredText / Markdown: one chunk per section, long sections split into windows. */
export function chunkDocs(path: string, text: string): Chunk[] {
  const lines = text.split(/\r?\n/);
  const md = path.endsWith('.md');
  const starts: Array<{ line: number; title: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (md) {
      const h = /^#{1,6}\s+(.*)$/.exec(l);
      if (h) starts.push({ line: i, title: h[1]!.trim() });
    } else if (i + 1 < lines.length && l.trim() && !RST_UNDERLINE.test(l) && RST_UNDERLINE.test(lines[i + 1]!) && lines[i + 1]!.trim().length >= Math.min(l.trim().length, 3)) {
      starts.push({ line: i, title: l.trim() });
    }
  }
  if (!starts.length || starts[0]!.line > 0) starts.unshift({ line: 0, title: '' });
  const chunks: Chunk[] = [];
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s]!.line;
    const to = (starts[s + 1]?.line ?? lines.length) - 1;
    for (let w = from; w <= to; w += WINDOW * 2) {
      const end = Math.min(to, w + WINDOW * 2 - 1);
      const body = lines.slice(w, end + 1);
      if (!body.some((l) => l.trim())) continue;
      chunks.push({ path, kind: 'section', ...(starts[s]!.title ? { name: starts[s]!.title } : {}), startLine: w + 1, endLine: end + 1, text: body.join('\n') });
    }
  }
  return chunks;
}

export function chunkWindows(path: string, text: string): Chunk[] {
  const lines = text.split(/\r?\n/);
  const chunks: Chunk[] = [];
  for (let s = 0; s < lines.length; s += WINDOW) {
    const part = lines.slice(s, s + WINDOW);
    if (part.some((l) => l.trim())) chunks.push({ path, kind: 'window', startLine: s + 1, endLine: s + part.length, text: part.join('\n') });
  }
  return chunks;
}

export function chunkFile(path: string, text: string): Chunk[] {
  if (path.endsWith('.py') || path.endsWith('.pyi')) return chunkPython(path, text);
  if (path.endsWith('.rst') || path.endsWith('.md')) return chunkDocs(path, text);
  return chunkWindows(path, text);
}
