import type { HudView } from "./hudModel";

const GREEN = "#39ff14";
const AMBER = "#ffb000";

const STATUS_TEXT: Record<HudView["status"], string> = { idle: "", listening: "listening…", thinking: "thinking…", speaking: "speaking…" };

/**
 * The glasses show a mirror of this screen. Pure black reads as see-through, so: black background, one bright
 * arrow, big text. Zone mode draws a coarse amber dashed arrow. All text is >= 32 px except the small
 * always-visible recording dot.
 */
export class Hud {
  private readonly arrow: SVGSVGElement;
  private readonly path: SVGPathElement;
  private readonly label = el("div", "label");
  private readonly zone = el("div", "zone");
  private readonly meta = el("div", "meta");
  private readonly status = el("div", "status");
  private readonly rec = el("div", "rec");
  private readonly debug = el("pre", "debug");
  private readonly toast = el("div", "toast");
  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly root: HTMLElement) {
    injectStyle();
    this.arrow = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    this.arrow.setAttribute("viewBox", "-100 -100 200 200");
    this.arrow.classList.add("arrow");
    this.path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    // arrow pointing up (0 deg = straight ahead)
    this.path.setAttribute("d", "M0 -85 L55 5 L18 5 L18 80 L-18 80 L-18 5 L-55 5 Z");
    this.path.setAttribute("stroke-linejoin", "round");
    this.arrow.appendChild(this.path);
    this.rec.innerHTML = '<span class="dot"></span>REC';
    this.rec.title = "tap to toggle the debug overlay";
    this.rec.addEventListener("click", () => this.toggleDebug()); // dev convenience only; nothing else uses taps
    root.replaceChildren(this.arrow, this.label, this.zone, this.meta, this.status, this.rec, this.toast, this.debug);
    this.debug.hidden = true;
  }

  render(v: HudView, recording: boolean) {
    const zoneMode = v.mode === "zone";
    this.arrow.style.visibility = v.hasTarget ? "visible" : "hidden";
    this.arrow.style.transform = `rotate(${v.angleDeg.toFixed(1)}deg)`;
    this.path.setAttribute("fill", zoneMode ? "none" : GREEN);
    this.path.setAttribute("stroke", zoneMode ? AMBER : GREEN);
    this.path.setAttribute("stroke-width", zoneMode ? "9" : "2");
    this.path.setAttribute("stroke-dasharray", zoneMode ? "16 12" : "");
    this.label.textContent = v.label;
    this.label.style.color = zoneMode ? AMBER : GREEN;
    this.zone.textContent = v.hasTarget ? [v.zone && `near ${v.zone}`, v.age].filter(Boolean).join(" · ") : "";
    this.meta.textContent = v.hasTarget ? v.distance : "";
    this.status.textContent = STATUS_TEXT[v.status];
    this.rec.style.visibility = recording ? "visible" : "hidden";
  }

  setDebug(lines: string[]) {
    if (!this.debug.hidden) this.debug.textContent = lines.join("\n");
  }
  toggleDebug() {
    this.debug.hidden = !this.debug.hidden;
  }
  showToast(text: string, ms = 3500) {
    this.toast.textContent = text;
    this.toast.style.visibility = "visible";
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => (this.toast.style.visibility = "hidden"), ms);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  return e;
}

function injectStyle() {
  if (document.getElementById("hud-style")) return;
  const s = document.createElement("style");
  s.id = "hud-style";
  s.textContent = `
    html, body { margin: 0; height: 100%; background: #000; color: #fff; overflow: hidden; font-family: system-ui, sans-serif; }
    #hud { position: fixed; inset: 0; background: #000; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; text-align: center; }
    .arrow { width: 46vmin; height: 46vmin; transition: none; will-change: transform; }
    .label { font-size: 56px; font-weight: 700; line-height: 1.1; min-height: 1.1em; }
    .zone { font-size: 36px; color: #fff; }
    .meta { font-size: 36px; color: #fff; }
    .status { font-size: 32px; color: ${GREEN}; min-height: 1.2em; }
    .rec { position: fixed; top: 10px; right: 14px; font-size: 14px; color: #f33; letter-spacing: 1px; }
    .rec .dot { display: inline-block; width: 10px; height: 10px; border-radius: 50%; background: #f33; margin-right: 6px; }
    .toast { position: fixed; bottom: 16px; left: 0; right: 0; font-size: 32px; color: ${AMBER}; visibility: hidden; }
    .debug { position: fixed; left: 8px; top: 8px; margin: 0; font-size: 13px; text-align: left; color: #8f8; background: rgba(0,0,0,.6); }
  `;
  document.head.appendChild(s);
}
