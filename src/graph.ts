import type { App } from 'obsidian';
import type { Ball, Playground } from './engine/personality';

/*
 * The nodes of open graph views (global and local) as balls the pet can play with, in CSS
 * px. Obsidian has no public API for the graph, so this reads its renderer the way the
 * view's own node dragging does, and does nothing if that ever changes shape: a node is
 * moved by pinning it in the layout simulation, and let go so the graph pulls it back.
 */

interface GraphNode { id: string; x: number; y: number; getSize?: () => number; }
interface GraphRenderer {
  nodes: GraphNode[];
  interactiveEl: HTMLElement;
  width: number;
  scale: number;
  panX: number;
  panY: number;
  worker: { postMessage(m: unknown): void };
}

export class GraphBalls implements Playground {
  constructor(private app: App) {}

  /** Each visible graph view's renderer, with its box on screen and CSS px per renderer px. */
  private views() {
    const out: { r: GraphRenderer; box: DOMRect; k: number }[] = [];
    for (const type of ['graph', 'localgraph']) {
      for (const leaf of this.app.workspace.getLeavesOfType(type)) {
        const r = (leaf.view as unknown as { renderer?: GraphRenderer }).renderer;
        if (!r?.nodes || !r.interactiveEl || !r.worker || !r.width) continue;
        const box = r.interactiveEl.getBoundingClientRect();
        if (box.width < 50 || box.height < 50 || !r.interactiveEl.isConnected || r.interactiveEl.offsetParent === null) continue;
        out.push({ r, box, k: box.width / r.width });
      }
    }
    return out;
  }

  balls(): Ball[] {
    const out: Ball[] = [];
    try {
      for (const { r, box, k } of this.views()) {
        for (const n of r.nodes) {
          const x = box.left + (n.x * r.scale + r.panX) * k, y = box.top + (n.y * r.scale + r.panY) * k;
          if (x < box.left || x > box.right || y < box.top || y > box.bottom) continue;
          out.push({ id: n.id, x, y, r: Math.max(3, (n.getSize?.() ?? 5) * r.scale * k) });
        }
      }
    } catch { /* the graph's internals changed: nothing to play with */ }
    return out;
  }

  push(id: string, x: number, y: number) {
    this.send(id, (r, box, k) => ({ alpha: 0.3, alphaTarget: 0.3, run: true, forceNode: { id, x: ((x - box.left) / k - r.panX) / r.scale, y: ((y - box.top) / k - r.panY) / r.scale } }));
  }

  letGo(id: string) {
    this.send(id, () => ({ alphaTarget: 0, forceNode: { id, x: null, y: null } }));
  }

  private send(id: string, message: (r: GraphRenderer, box: DOMRect, k: number) => unknown) {
    try {
      for (const { r, box, k } of this.views()) if (r.nodes.some((n) => n.id === id)) r.worker.postMessage(message(r, box, k));
    } catch { /* as above */ }
  }
}
