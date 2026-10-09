import { sanitizeHTMLToDom } from "obsidian";
import type { TranslatorSettings } from "../settings";
import { FROG_ORB_SVG } from "./icons";
import { t } from "../i18n";

export interface OrbActions {
  onToggle: () => void;
  onPositionChange?: () => void;
  isRunning: () => boolean;
}

const SIZE = 44;
const DOCK_EDGE_GAP = 12;

/**
 * One accessible button toggles the reading layer. Pointer gestures only handle
 * dragging; native click handles mouse, touch, keyboard and assistive activation.
 */
export class FloatingOrb {
  private root: HTMLElement;
  private ball: HTMLButtonElement;
  private suppressClick = false;
  private resizeObserver: ResizeObserver | null = null;
  private dragState: { pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null = null;
  private destroyed = false;

  constructor(
    private container: HTMLElement,
    private settings: TranslatorSettings,
    private actions: OrbActions
  ) {
    this.root = this.container.createDiv();
    this.root.className = "obstr-orb";
    this.ball = this.root.createEl("button");
    this.ball.type = "button";
    this.ball.className = "obstr-orb-ball";
    this.ball.setAttribute("aria-label", t("pluginTitle"));
    this.ball.append(sanitizeHTMLToDom(FROG_ORB_SVG));

    this.root.append(this.ball);
    this.container.appendChild(this.root);
    this.bind();
    this.applySettings(settings);
    if (typeof ResizeObserver !== "undefined") {
      this.resizeObserver = new ResizeObserver(() => {
        if (!this.dragState) this.applySettings(this.settings);
      });
      this.resizeObserver.observe(this.container);
    }
  }

  private bind(): void {
    this.ball.addEventListener("click", (event) => {
      event.stopPropagation();
      if (this.suppressClick && event.detail !== 0) {
        this.suppressClick = false;
        return;
      }
      this.suppressClick = false;
      this.actions.onToggle();
      this.syncRunningState();
    });

    this.ball.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 || event.isPrimary === false) return;
      this.suppressClick = false;
      try { this.ball.setPointerCapture?.(event.pointerId); } catch { /* detached pointer */ }
      const rect = this.root.getBoundingClientRect();
      this.dragState = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        originX: rect.left,
        originY: rect.top,
        moved: false,
      };
    });

    this.ball.addEventListener("pointermove", (event) => {
      if (!this.dragState || this.dragState.pointerId !== event.pointerId) return;
      const dx = event.clientX - this.dragState.startX;
      const dy = event.clientY - this.dragState.startY;
      if (!this.dragState.moved && Math.hypot(dx, dy) < 8) return;
      this.dragState.moved = true;
      const x = this.dragState.originX + dx;
      const y = this.dragState.originY + dy;
      this.place(x, y);
    });

    const finish = (event: PointerEvent) => {
      if (!this.dragState || this.dragState.pointerId !== event.pointerId) return;
      const moved = this.dragState.moved;
      this.dragState = null;
      try { this.ball.releasePointerCapture?.(event.pointerId); } catch { /* capture already lost */ }
      if (moved) {
        this.suppressClick = true;
        this.snapToEdge();
      }
    };
    this.ball.addEventListener("pointerup", finish);
    const cancel = (event: PointerEvent) => {
      if (this.dragState?.pointerId !== event.pointerId) return;
      const moved = this.dragState.moved;
      this.dragState = null;
      this.suppressClick = true;
      if (moved) this.snapToEdge();
    };
    this.ball.addEventListener("pointercancel", cancel);
    this.ball.addEventListener("lostpointercapture", cancel);
  }

  private place(left: number, top: number): void {
    const bounds = this.container.getBoundingClientRect();
    const clampedX = Math.min(
      Math.max(0, left - bounds.left),
      Math.max(0, bounds.width - SIZE)
    );
    const clampedY = Math.min(
      Math.max(0, top - bounds.top),
      Math.max(0, bounds.height - SIZE)
    );
    this.root.setCssStyles({ left: `${clampedX}px`, top: `${clampedY}px`, right: "auto" });
  }

  private snapToEdge(): void {
    const bounds = this.container.getBoundingClientRect();
    const rect = this.root.getBoundingClientRect();
    const nearerLeft =
      rect.left - bounds.left < bounds.width - (rect.right - bounds.left);
    const x = nearerLeft
      ? bounds.left + DOCK_EDGE_GAP
      : bounds.right - SIZE - DOCK_EDGE_GAP;
    this.place(x, rect.top);
    this.settings.orbCustomX = Math.round(parseFloat(this.root.style.left));
    this.settings.orbCustomY = Math.round(parseFloat(this.root.style.top));
    this.settings.orbPosition = "custom";
    this.actions.onPositionChange?.();
  }

  applySettings(settings: TranslatorSettings): void {
    this.settings = settings;
    this.root.setCssProps({ "--obstr-orb-opacity": String(settings.orbOpacity) });
    this.root.classList.toggle("is-hidden", !settings.showOrb);
    this.syncRunningState();

    if (settings.orbPosition === "custom" && settings.orbCustomX !== null && settings.orbCustomY !== null) {
      const bounds = this.container.getBoundingClientRect();
      this.place(bounds.left + settings.orbCustomX, bounds.top + settings.orbCustomY);
      return;
    }
    const dockLeft = settings.orbPosition === "left-middle";
    this.root.setCssStyles({
      left: dockLeft ? `${DOCK_EDGE_GAP}px` : "auto",
      right: dockLeft ? "auto" : `${DOCK_EDGE_GAP}px`,
      top: `calc(50% - ${SIZE / 2}px)`,
    });
  }

  syncRunningState(): void {
    const enabled = this.actions.isRunning();
    this.root.classList.toggle("is-running", enabled);
    this.ball.setAttribute("aria-pressed", String(enabled));
    const label = t(enabled ? "orbDisable" : "orbEnable");
    this.ball.setAttribute("aria-label", label);
    this.ball.title = label;
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle("is-offscreen", !visible);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.resizeObserver?.disconnect();
    this.dragState = null;
    this.root.remove();
  }
}
