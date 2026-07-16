// Canvas renderer for a single linegrid (grid 1) driven by nvim's `redraw`
// UI events. It maintains a cell buffer + highlight table, applies batched
// redraw calls, and repaints on `flush` via requestAnimationFrame.
//
// Supported redraw events: grid_resize, default_colors_set, hl_attr_define,
// grid_line, grid_clear, grid_cursor_goto, grid_scroll, mode_change, flush.
// Multi-grid (ext_multigrid) is out of scope for the spike.

interface Cell {
  text: string;
  hl: number;
}

interface HlAttr {
  foreground?: number;
  background?: number;
  reverse?: boolean;
}

export class GridRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private cols = 0;
  private rows = 0;
  private cells: Cell[][] = [];
  private readonly hl = new Map<number, HlAttr>();
  private defaultFg = 0xcdd6f4;
  private defaultBg = 0x1e1e2e;
  private cursor = { row: 0, col: 0 };
  private cursorShape: "block" | "bar" = "block";
  private cellW = 9;
  private cellH = 18;
  private baseline = 14;
  private dirty = false;
  private rafPending = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly font = "14px ui-monospace, Menlo, monospace",
  ) {
    this.ctx = canvas.getContext("2d")!;
    this.measure();
  }

  private measure(): void {
    this.ctx.font = this.font;
    const m = this.ctx.measureText("M");
    this.cellW = Math.ceil(m.width);
    this.cellH = Math.ceil((m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) * 1.35);
    this.baseline = Math.ceil(m.actualBoundingBoxAscent * 1.15);
  }

  sizeForGrid(cols: number, rows: number): { width: number; height: number } {
    return { width: cols * this.cellW, height: rows * this.cellH };
  }

  gridForSize(width: number, height: number): { cols: number; rows: number } {
    return {
      cols: Math.max(20, Math.floor(width / this.cellW)),
      rows: Math.max(4, Math.floor(height / this.cellH)),
    };
  }

  // Cursor top-left pixel + cell height in canvas CSS pixels. Used by the
  // engine frame to park the hidden IME input at the caret so the composition
  // candidate window renders in the right place.
  cursorPixel(): { x: number; y: number; height: number } {
    return { x: this.cursor.col * this.cellW, y: this.cursor.row * this.cellH, height: this.cellH };
  }

  apply(batch: unknown[]): void {
    for (const entry of batch as [string, ...unknown[][]][]) {
      const [name, ...calls] = entry;
      for (const args of calls) this.handle(name, args as unknown[]);
    }
  }

  private handle(name: string, a: unknown[]): void {
    switch (name) {
      case "grid_resize": {
        const [, c, r] = a as number[];
        this.cols = c;
        this.rows = r;
        this.cells = Array.from({ length: r }, () =>
          Array.from({ length: c }, () => ({ text: " ", hl: 0 })),
        );
        const size = this.sizeForGrid(c, r);
        this.canvas.width = size.width * devicePixelRatio;
        this.canvas.height = size.height * devicePixelRatio;
        this.canvas.style.width = `${size.width}px`;
        this.canvas.style.height = `${size.height}px`;
        this.ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
        break;
      }
      case "default_colors_set": {
        const [fg, bg] = a as number[];
        if (fg >= 0) this.defaultFg = fg;
        if (bg >= 0) this.defaultBg = bg;
        break;
      }
      case "hl_attr_define": {
        const [id, attr] = a as [number, HlAttr];
        this.hl.set(id, attr ?? {});
        break;
      }
      case "grid_line": {
        const [, row, colStart, cellsArg] = a as [
          number,
          number,
          number,
          [string, number?, number?][],
        ];
        let col = colStart;
        let hlId = 0;
        for (const cell of cellsArg) {
          const [text, maybeHl, repeat = 1] = cell;
          if (maybeHl !== undefined) hlId = maybeHl;
          for (let i = 0; i < repeat; i++) {
            if (this.cells[row]?.[col]) this.cells[row][col] = { text, hl: hlId };
            col++;
          }
        }
        break;
      }
      case "grid_clear": {
        for (const rowCells of this.cells) {
          for (const cell of rowCells) {
            cell.text = " ";
            cell.hl = 0;
          }
        }
        break;
      }
      case "grid_cursor_goto": {
        const [, r, c] = a as number[];
        this.cursor = { row: r, col: c };
        break;
      }
      case "grid_scroll": {
        const [, top, bot, left, right, rows] = a as number[];
        if (rows > 0) {
          for (let r = top; r < bot - rows; r++)
            for (let c = left; c < right; c++) this.cells[r][c] = this.cells[r + rows][c];
        } else if (rows < 0) {
          for (let r = bot - 1; r >= top - rows; r--)
            for (let c = left; c < right; c++) this.cells[r][c] = this.cells[r + rows][c];
        }
        break;
      }
      case "mode_change": {
        const [mode] = a as [string];
        this.cursorShape =
          mode.startsWith("insert") || mode.startsWith("cmdline") ? "bar" : "block";
        break;
      }
      case "flush":
        this.scheduleDraw();
        break;
    }
  }

  private scheduleDraw(): void {
    this.dirty = true;
    if (this.rafPending) return;
    this.rafPending = true;
    requestAnimationFrame(() => {
      this.rafPending = false;
      if (this.dirty) {
        this.dirty = false;
        this.draw();
      }
    });
  }

  private color(value: number): string {
    return `#${value.toString(16).padStart(6, "0")}`;
  }

  private draw(): void {
    const { ctx } = this;
    ctx.font = this.font;
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = this.color(this.defaultBg);
    ctx.fillRect(0, 0, this.cols * this.cellW, this.rows * this.cellH);
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const cell = this.cells[r][c];
        const attr = this.hl.get(cell.hl) ?? {};
        const fg = attr.reverse
          ? (attr.background ?? this.defaultBg)
          : (attr.foreground ?? this.defaultFg);
        const bg = attr.reverse
          ? (attr.foreground ?? this.defaultFg)
          : (attr.background ?? this.defaultBg);
        if (bg !== this.defaultBg) {
          ctx.fillStyle = this.color(bg);
          ctx.fillRect(c * this.cellW, r * this.cellH, this.cellW, this.cellH);
        }
        if (cell.text !== " ") {
          ctx.fillStyle = this.color(fg);
          ctx.fillText(cell.text, c * this.cellW, r * this.cellH + this.baseline);
        }
      }
    }
    // Cursor: block (normal) draws an inverted cell; bar (insert/cmdline) a caret.
    const { row, col } = this.cursor;
    if (this.cursorShape === "block") {
      ctx.fillStyle = this.color(this.defaultFg);
      ctx.globalAlpha = 0.7;
      ctx.fillRect(col * this.cellW, row * this.cellH, this.cellW, this.cellH);
      ctx.globalAlpha = 1;
      const cell = this.cells[row]?.[col];
      if (cell && cell.text !== " ") {
        ctx.fillStyle = this.color(this.defaultBg);
        ctx.fillText(cell.text, col * this.cellW, row * this.cellH + this.baseline);
      }
    } else {
      ctx.fillStyle = this.color(this.defaultFg);
      ctx.fillRect(col * this.cellW, row * this.cellH, 2, this.cellH);
    }
  }
}
