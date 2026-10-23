/**
 * A cel the bridge wrote. `layer` undefined = the layer Aseprite defaults to, `frame`
 * undefined = the active frame (both resolved by whoever reads the record);
 * `everyLayer` = every image layer of that frame (frame_op copy_cel without a layer).
 */
export type DrawnCel = { layer?: string; frame?: number } | { everyLayer: true; frame: number };

/** Where TrackingAsepriteGateway reports what each call changed. */
export interface ISpriteActivityLog {
  /** One Aseprite transaction (one Ctrl+Z step) on `sprite`, optionally drawing `cels`. */
  recordStep(sprite: number, cels?: readonly DrawnCel[]): void;
  recordUndo(sprite: number, steps: number): void;
  recordRedo(sprite: number, steps: number): void;
}

/** Starts watching a sprite; what services depend on. */
export interface ISpriteWatcher {
  watch(sprite: number): ActivityWatch;
}

/** What happened to one sprite while it was watched. */
export interface ActivityWatch {
  readonly sprite: number;
  /** Undo steps added since the watch started, net of undo/redo: what "Undo AI run" takes back. */
  readonly undoSteps: number;
  /** Distinct cels written since the watch started. */
  readonly drawnCels: readonly DrawnCel[];
  /** Stops recording; the numbers stay readable. */
  close(): void;
}

const celKey = (cel: DrawnCel) => ("everyLayer" in cel ? `*\u0000${cel.frame}` : `${cel.layer ?? ""}\u0000${cel.frame ?? ""}`);

class WatchState implements ActivityWatch {
  private steps = 0;
  /** Steps of this watch that were undone and a redo brings back. */
  private redoable = 0;
  /**
   * Older steps (from before the watch) that an undo took back. Redo restores the oldest
   * undone step first, so these come back before any of ours do.
   */
  private undoneBefore = 0;
  private readonly cels = new Map<string, DrawnCel>();

  constructor(
    readonly sprite: number,
    private readonly detach: (watch: WatchState) => void,
  ) {}

  get undoSteps(): number {
    return this.steps;
  }

  get drawnCels(): readonly DrawnCel[] {
    return [...this.cels.values()];
  }

  close(): void {
    this.detach(this);
  }

  step(cels: readonly DrawnCel[]): void {
    this.steps++;
    // A new change clears Aseprite's redo stack.
    this.redoable = 0;
    this.undoneBefore = 0;
    for (const cel of cels) this.cels.set(celKey(cel), cel);
  }

  undo(n: number): void {
    const ours = Math.min(n, this.steps);
    this.steps -= ours;
    this.redoable += ours;
    this.undoneBefore += n - ours;
  }

  redo(n: number): void {
    const older = Math.min(n, this.undoneBefore);
    this.undoneBefore -= older;
    const ours = Math.min(n - older, this.redoable);
    this.redoable -= ours;
    this.steps += ours;
  }
}

/**
 * Counts what the bridge does to each sprite while someone watches it: a model run
 * watches its sprite to report its undo steps and to know which cels it drew. Only
 * watched sprites are recorded, so nothing accumulates between runs.
 */
export class SpriteActivity implements ISpriteActivityLog, ISpriteWatcher {
  private readonly watches = new Map<number, Set<WatchState>>();

  watch(sprite: number): ActivityWatch {
    let set = this.watches.get(sprite);
    if (!set) this.watches.set(sprite, (set = new Set()));
    const watches = set;
    const watch = new WatchState(sprite, (w) => {
      watches.delete(w);
      if (watches.size === 0 && this.watches.get(sprite) === watches) this.watches.delete(sprite);
    });
    watches.add(watch);
    return watch;
  }

  recordStep(sprite: number, cels: readonly DrawnCel[] = []): void {
    for (const watch of this.watchesOf(sprite)) watch.step(cels);
  }

  recordUndo(sprite: number, steps: number): void {
    for (const watch of this.watchesOf(sprite)) watch.undo(steps);
  }

  recordRedo(sprite: number, steps: number): void {
    for (const watch of this.watchesOf(sprite)) watch.redo(steps);
  }

  private watchesOf(sprite: number): Iterable<WatchState> {
    return this.watches.get(sprite) ?? [];
  }
}
