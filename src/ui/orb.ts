import type { TranslatorSettings, OrbPosition } from "../settings";
import { FROG_ORB_SVG } from "./icons";
import { t } from "../i18n";

export interface OrbActions {
  onToggle: () => void;
  onTranslateSelection: () => void;
  onStop: () => void;
  onClear: () => void;
  isRunning: () => boolean;
}

const SIZE = 44;
const DOCK_EDGE_GAP = 12;

/**
 * Semi-hidden docked orb: it sits at the reading pane edge at low opacity and
 * blooms into a menu on hover. Drag is pointer-based so it works with both mouse
 * and pen, and the custom position is stored in settings rather than CSS.
 */
export class FloatingOrb {
  private root: HTMLElement;
  private ball: HTMLButtonElement;
  private menu: HTMLElement;
  private expanded = false;
  private dragState: { pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null = null;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(
    private container: HTMLElement,
    private settings: TranslatorSettings,
    private actions: OrbActions
  ) {
    this.root = document.createElement("div");
    this.root.className = "obstr-orb";
    this.ball = document.createElement("button");
    this.ball.type = "button";
    this.ball.className = "obstr-orb-ball";
    this.ball.setAttribute("aria-label", t("pluginTitle"));
    this.ball.innerHTML = FROG_ORB_SVG;

    this.menu = document.createElement("div");
    this.menu.className = "obstr-orb-menu";
    this.menu.append(
      this.item(t("orbToggle"), () => this.actions.onToggle()),
      this.item(t("orbSelection"), () => this.actions.onTranslateSelection()),
      this.item(t("orbStop"), () => this.actions.onStop()),
      this.item(t("orbClear"), () => this.actions.onClear())
    );

    this.root.append(this.ball, this.menu);
    this.container.appendChild(this.root);
    this.bind();
    this.applySettings(settings);
  }

  private item(label: string, onClick: () => void): HTMLElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "obstr-orb-item";
    button.textContent = label;
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      this.collapse(true);
      onClick();
    });
    return button;
  }

  private bind(): void {
    this.ball.addEventListener("pointerenter", () => this.expand());
    this.ball.addEventListener("pointerleave", () => this.scheduleCollapse());
    this.menu.addEventListener("pointerenter", () => this.cancelCollapse());
    this.menu.addEventListener("pointerleave", () => this.scheduleCollapse());

    this.ball.addEventListener("pointerdown", (event) => {
      this.ball.setPointerCapture(event.pointerId);
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
      if (!this.dragState.moved && Math.hypot(dx, dy) < 4) return;
      this.dragState.moved = true;
      this.cancelCollapse();
      const x = this.dragState.originX + dx;
      const y = this.dragState.originY + dy;
      this.place(x, y);
    });

    const finish = (event: PointerEvent) => {
      if (!this.dragState || this.dragState.pointerId !== event.pointerId) return;
      const moved = this.dragState.moved;
      this.dragState = null;
      this.ball.releasePointerCapture?.(event.pointerId);
      if (moved) {
        this.snapToEdge();
      } else {
        // A plain click toggles translation; the menu carries the other actions.
        this.actions.onToggle();
        this.expand();
      }
    };
    this.ball.addEventListener("pointerup", finish);
    this.ball.addEventListener("pointercancel", (event) => {
      if (this.dragState?.pointerId === event.pointerId) {
        const moved = this.dragState.moved;
        this.dragState = null;
        if (moved) this.snapToEdge();
      }
    });
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
    this.root.style.left = `${clampedX}px`;
    this.root.style.top = `${clampedY}px`;
    this.root.style.right = "auto";
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
    this.settings.orbCustomX = Math.round(rect.left);
    this.settings.orbCustomY = Math.round(rect.top);
    this.settings.orbPosition = "custom";
  }

  private expand(): void {
    this.cancelCollapse();
    this.expanded = true;
    this.root.classList.add("is-expanded");
  }

  private scheduleCollapse(): void {
    this.cancelCollapse();
    this.closeTimer = setTimeout(() => this.collapse(false), 220);
  }

  private cancelCollapse(): void {
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
  }

  private collapse(immediate: boolean): void {
    if (!this.expanded) return;
    if (!immediate) {
      if (this.openTimer !== null) clearTimeout(this.openTimer);
      this.openTimer = setTimeout(() => this.collapse(true), 180);
      return;
    }
    this.expanded = false;
    this.root.classList.remove("is-expanded");
  }

  applySettings(settings: TranslatorSettings): void {
    this.settings = settings;
    this.root.style.setProperty("--obstr-orb-opacity", String(settings.orbOpacity));
    this.root.classList.toggle("is-hidden", !settings.showOrb);
    this.syncRunningState();

    if (settings.orbPosition === "custom" && settings.orbCustomX !== null && settings.orbCustomY !== null) {
      this.root.style.left = `${settings.orbCustomX}px`;
      this.root.style.top = `${settings.orbCustomY}px`;
      this.root.style.right = "auto";
      return;
    }
    const bounds = this.container.getBoundingClientRect();
    const dockLeft = settings.orbPosition === "left-middle";
    this.root.style.left = dockLeft
      ? `${DOCK_EDGE_GAP}px`
      : `${Math.max(0, bounds.width - SIZE - DOCK_EDGE_GAP)}px`;
    this.root.style.top = `${Math.max(0, bounds.height / 2 - SIZE / 2)}px`;
    this.root.style.right = "auto";
  }

  syncRunningState(): void {
    this.root.classList.toggle("is-running", this.actions.isRunning());
  }

  setVisible(visible: boolean): void {
    this.root.classList.toggle("is-offscreen", !visible);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.openTimer !== null) clearTimeout(this.openTimer);
    if (this.closeTimer !== null) clearTimeout(this.closeTimer);
    this.root.remove();
  }
}
