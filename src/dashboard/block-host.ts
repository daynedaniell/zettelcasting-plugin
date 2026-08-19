import { MarkdownRenderChild } from 'obsidian';

import { CachedResource, Snapshot } from './client';

/**
 * The scaffold every dashboard block sits on.
 *
 * It owns the parts that are the same for all of them and easy to get wrong:
 * when to revalidate, when to stop, and tearing every listener back down. A
 * block supplies only a render function.
 *
 * Registering as a `MarkdownRenderChild` is what makes teardown reliable —
 * Obsidian unloads the child when the block leaves the preview, whether that is
 * a note being closed, an edit re-rendering it, or the plugin being disabled.
 */

export interface BlockHostOptions<T> {
  /** The block language, e.g. `zc-connections`. Used to label errors. */
  name: string;
  resource: CachedResource<T>;
  /**
   * Repaint from this snapshot. Called on first render, on every settled
   * revalidation, and on the tick that ages the relative timestamps.
   */
  // A property rather than a method signature: the host stores this function
  // detached from its object, which a method signature would not make safe.
  render: (snapshot: Snapshot<T>) => void;
  /**
   * How often to repaint purely so "2 minutes ago" stays true. Runs only while
   * the block is on screen and the app is in the foreground, and makes no
   * network calls.
   */
  tickMs?: number;
}

export const DEFAULT_TICK_MS = 30_000;

/** Only the part of the constructor this file uses. */
type IntersectionObserverCtor = new (
  callback: (entries: IntersectionObserverEntry[]) => void
) => IntersectionObserver;

export class DashboardBlockHost<T> extends MarkdownRenderChild {
  private readonly name: string;
  private readonly resource: CachedResource<T>;
  private readonly renderFn: (snapshot: Snapshot<T>) => void;
  private readonly tickMs: number;

  private observer: IntersectionObserver | null = null;
  private tickTimer: number | null = null;
  private unsubscribe: (() => void) | null = null;

  /** Whether the block is on screen. Starts false until the observer reports. */
  private visible = false;

  constructor(containerEl: HTMLElement, options: BlockHostOptions<T>) {
    super(containerEl);
    this.name = options.name;
    this.resource = options.resource;
    this.renderFn = options.render;
    this.tickMs = options.tickMs ?? DEFAULT_TICK_MS;
  }

  onload() {
    // Paint from cache before anything else. This is the whole point of the
    // cache-first design: the block is never empty and never a bare spinner,
    // even offline.
    this.repaint();

    this.unsubscribe = this.resource.subscribe(() => this.repaint());

    // The block's own window, so this still works in a popped-out window.
    const win = this.containerEl.win;

    // Pause everything while the app is in the background. Without this a
    // vault left open overnight keeps ticking and revalidating on wake.
    this.registerDomEvent(win.document, 'visibilitychange', () => {
      if (win.document.hidden) {
        this.stopTicking();
      } else if (this.visible) {
        this.startTicking();
        void this.resource.ensureFresh();
      }
    });

    this.observeVisibility(win);
  }

  onunload() {
    this.stopTicking();
    this.observer?.disconnect();
    this.observer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    // `registerDomEvent` listeners and any child components are Obsidian's to
    // remove; everything this class opened itself is closed above.
  }

  /**
   * Revalidate when the block scrolls into view, and stop the timer when it
   * scrolls out. A long dashboard note therefore only refreshes the panels
   * someone is actually looking at.
   */
  private observeVisibility(win: Window) {
    // Obsidian's `Window` type does not declare the constructor, but the
    // block's own window is where it has to come from: in a popped-out window
    // the global one would watch the wrong document. Named locally rather than
    // asserted through `globalThis`, so the shape being assumed is visible.
    const Observer = (
      win as unknown as { IntersectionObserver?: IntersectionObserverCtor }
    ).IntersectionObserver;

    if (typeof Observer !== 'function') {
      // Every platform Obsidian ships on has this; if one ever does not, a
      // block that renders and refreshes once beats one that never refreshes.
      this.visible = true;
      this.startTicking();
      void this.resource.ensureFresh();
      return;
    }

    const observer = new Observer((entries) => {
      const isVisible = entries.some((entry) => entry.isIntersecting);
      if (isVisible === this.visible) return;
      this.visible = isVisible;

      if (!isVisible) {
        this.stopTicking();
        return;
      }

      this.startTicking();
      // `ensureFresh` is a no-op below the staleness floor, so scrolling past
      // a block repeatedly does not generate requests.
      void this.resource.ensureFresh();
    });

    this.observer = observer;
    observer.observe(this.containerEl);
  }

  private startTicking() {
    if (this.tickTimer !== null) return;
    const win = this.containerEl.win;
    this.tickTimer = win.setInterval(() => this.repaint(), this.tickMs);
  }

  private stopTicking() {
    if (this.tickTimer === null) return;
    this.containerEl.win.clearInterval(this.tickTimer);
    this.tickTimer = null;
  }

  /** A render that can never take the note's preview down with it. */
  private repaint() {
    try {
      this.renderFn(this.resource.snapshot());
    } catch (e) {
      this.containerEl.empty();
      renderBlockError(
        this.containerEl,
        e instanceof Error
          ? e.message
          : 'Something went wrong rendering this block.',
        this.name
      );
    }
  }
}

/**
 * The inline error a block shows in place of its content.
 *
 * Deliberately not a `Notice`: the problem is with this block, in this note,
 * and the fix is to edit it — so the message belongs where the block is.
 */
export function renderBlockError(
  container: HTMLElement,
  message: string,
  blockName: string
) {
  const el = container.createDiv({ cls: 'zc-block-error' });
  el.createSpan({ cls: 'zc-block-error-label', text: blockName });
  el.createSpan({ text: message });
  return el;
}

/** A non-fatal note, shown above content that rendered fine regardless. */
export function renderBlockWarning(container: HTMLElement, message: string) {
  return container.createDiv({ cls: 'zc-block-warning', text: message });
}
