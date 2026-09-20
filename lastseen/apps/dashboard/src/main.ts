import { INITIAL_STATE, arrowAngle, distanceM, formatAge } from "@lastseen/shared";
import type { ObjectRow, ServerMessage, Trace, TrackerState } from "@lastseen/shared";
import { connectTracker } from "@lastseen/shared/connect";

const params = new URLSearchParams(location.search);
const device = params.get("device") ?? "demo";
let token = params.get("token") ?? localStorage.getItem("lastseen.dash.token") ?? "";
if (!token) token = prompt("Device token") ?? "";
if (token) localStorage.setItem("lastseen.dash.token", token);

let state: TrackerState = INITIAL_STATE;
let objects: ObjectRow[] = [];
const traces: Trace[] = [];

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Build DOM with textContent only: labels and descriptions come from a model and must never be parsed as HTML. */
function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, ...kids: Array<Node | string | null | undefined>): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const k of kids) if (k != null) e.append(k);
  return e;
}

const conn = connectTracker({
  host: location.host,
  device,
  token,
  onOpen: () => {
    setConn(true);
    conn.send({ type: "hello", contractVersion: 2, role: "dashboard" });
  },
  onClose: () => setConn(false),
  onState: (s) => {
    state = s;
    renderState();
  },
  onMessage: onServer,
});

function setConn(on: boolean) {
  const p = $("conn");
  p.textContent = on ? `connected · ${device}` : "disconnected";
  p.className = `pill ${on ? "on" : "off"}`;
}

function onServer(m: ServerMessage) {
  if (m.type === "ledger") {
    objects = m.objects;
    renderLedger();
  } else if (m.type === "trace") {
    if (!traces.some((t) => t.id === m.trace.id)) traces.unshift(m.trace);
    traces.sort((a, b) => b.ts - a.ts);
    traces.length = Math.min(traces.length, 150);
    renderTraces();
  }
}

// ---------------------------------------------------------------- controls
$<HTMLFormElement>("ask").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $<HTMLInputElement>("ask-text");
  const text = input.value.trim();
  if (!text) return;
  conn.send({ type: "query", turnId: `d${Date.now()}`, text });
  input.value = "";
});
$("capture").addEventListener("click", () => conn.send({ type: "force_capture" }));
$("forget").addEventListener("click", () => {
  if (confirm("Forget every object, sighting and thumbnail for this device?")) conn.send({ type: "forget", target: "all" });
});
const ptt = $("ptt");
const pttSet = (action: "down" | "up") => {
  ptt.classList.toggle("active", action === "down");
  conn.send({ type: "remote_ptt", action });
};
ptt.addEventListener("pointerdown", () => pttSet("down"));
for (const ev of ["pointerup", "pointerleave", "pointercancel"]) ptt.addEventListener(ev, () => ptt.classList.contains("active") && pttSet("up"));

// ---------------------------------------------------------------- render
const thumbSrc = (o: ObjectRow) => (o.thumbUrl ? `${o.thumbUrl}?token=${encodeURIComponent(token)}` : null);

function renderState() {
  $("agent-status").textContent = state.status;
  $("c-acc").textContent = String(state.ingest.accepted);
  $("c-drop").textContent = String(state.ingest.dropped);
  const reasons = $("reasons");
  reasons.replaceChildren(...Object.entries(state.ingest.reasons).map(([r, n]) => h("span", "chip", `${r} × ${n}`)));
  $("last-reply").textContent = state.lastReply ?? "";
  const { spentCad, capCad } = state.budget;
  $("budget-text").textContent = `${spentCad.toFixed(2)} / ${capCad.toFixed(2)} CAD`;
  const bar = $("budget-bar");
  bar.style.width = `${Math.min(100, (spentCad / Math.max(0.01, capCad)) * 100)}%`;
  bar.style.background = spentCad / capCad > 0.8 ? "var(--red)" : "var(--green)";
  const t = state.target;
  $("target-line").textContent = t
    ? `Target: ${t.label} · ${t.zone ?? "unknown zone"} · ${formatAge(t.ageSec + (Date.now() - t.setAt) / 1000)} · ${t.mode} · arrow ${arrowAngle(t, state.pose, null, 0, Date.now()).toFixed(0)}° · ${distanceM(state.pose, t).toFixed(1)} m`
    : "No target";
  drawMap();
}

function renderLedger() {
  $("ledger-count").textContent = `${objects.length} object${objects.length === 1 ? "" : "s"}`;
  const now = Date.now();
  $("ledger").replaceChildren(
    ...[...objects]
      .sort((a, b) => b.lastSeenAt - a.lastSeenAt)
      .map((o) => {
        const src = thumbSrc(o);
        const thumb = h("div", "thumb");
        if (src) {
          thumb.append(h("img"));
          (thumb.firstChild as HTMLImageElement).src = src;
          (thumb.firstChild as HTMLImageElement).alt = o.label;
        } else thumb.append(h("div", "noimg", "no frame kept"));
        if (o.box) {
          const [x, y, w, hh] = o.box;
          const b = h("div", `box ${o.boxSource}`, h("span", "", `${o.boxSource === "detector" ? "det" : "omni"}`));
          b.style.cssText = `left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${hh * 100}%`;
          thumb.append(b);
        }
        return h(
          "div", "item", thumb,
          h("div", "meta",
            h("div", "title", o.label, h("span", `tag ${o.status}`, o.status)),
            h("div", "sub", `${o.zone ?? "unknown zone"} · ${formatAge((now - o.lastSeenAt) / 1000)} · conf ${(o.confidence * 100).toFixed(0)}%`),
            h("div", "sub", o.description),
            h("div", "sub", o.x != null && o.y != null ? `at (${o.x.toFixed(1)}, ${o.y.toFixed(1)}) m · box: ${o.boxSource}` : "no location"),
          ),
        );
      }),
  );
}

function renderTraces() {
  $("trace").replaceChildren(
    ...traces.map((t) => {
      const res = t.result as { dropped?: boolean; reason?: string; detail?: string } | null;
      const dropped = Boolean(res && res.dropped);
      const what = dropped ? `DROPPED · ${res!.reason}` : t.tool ? `${t.kind} · ${t.tool}` : t.kind;
      const brief = dropped ? (res!.detail ?? "") : summarize(t);
      const ms = t.latencyMs != null ? `${Math.round(t.latencyMs)} ms` : "";
      const cost = t.costCad > 0 ? ` · ${t.costCad.toFixed(3)} CAD` : "";
      return h(
        "div", `trace-item ${dropped ? "drop" : t.kind}`,
        h("div", "k", new Date(t.ts).toLocaleTimeString([], { hour12: false })),
        h("div", "", h("span", "what", what), h("span", "cost", `${ms}${cost}`), h("div", "", brief),
          h("details", "", h("summary", "", "details"), h("pre", "", JSON.stringify({ args: t.args, result: t.result }, null, 1)))),
      );
    }),
  );
}

function summarize(t: Trace): string {
  const r = t.result as Record<string, unknown> | null;
  if (!r) return "";
  if (t.kind === "omni" && t.tool === "understandUtterance") return String(r.final ?? (r.tool ? `→ ${String(r.tool)} ${JSON.stringify(r.args)}` : "")) + (r.transcript ? `  “${String(r.transcript)}”` : "");
  if (t.tool === "find_object") return `${(r.candidates as unknown[] | undefined)?.length ?? 0} candidate(s)`;
  if (t.tool === "guide_to") return r.ok ? `arrow → ${String(r.label)} (${String(r.mode)})` : String(r.error);
  if (t.kind === "final") return String(r.text ?? "");
  if (t.tool === "accepted") return `frames ${String(r.frames)} · boxes ${String(r.detections)}${r.still ? " · still" : ""}`;
  if (t.tool === "extractPlacements") return `${(r.events as unknown[] | undefined)?.length ?? 0} event(s) ${JSON.stringify(r.events)}`;
  return JSON.stringify(r).slice(0, 140);
}

// ---------------------------------------------------------------- map
const canvas = $<HTMLCanvasElement>("map");
const ctx = canvas.getContext("2d")!;

function drawMap() {
  const W = canvas.width;
  const H = canvas.height;
  ctx.fillStyle = "#080a0e";
  ctx.fillRect(0, 0, W, H);

  const pts: Array<[number, number]> = [[state.pose.x, state.pose.y]];
  for (const o of objects) if (o.x != null && o.y != null) pts.push([o.x, o.y]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const pad = 2;
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
  const span = Math.max(maxX - minX, (maxY - minY) * (W / H), 8);
  const scale = W / span;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const sx = (x: number) => W / 2 + (x - cx) * scale;
  const sy = (y: number) => H / 2 - (y - cy) * scale;

  // 1 m grid
  ctx.strokeStyle = "#141a26";
  ctx.lineWidth = 1;
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };
  for (let gx = Math.ceil(cx - W / 2 / scale); gx <= cx + W / 2 / scale; gx++) line(sx(gx), 0, sx(gx), H);
  for (let gy = Math.ceil(cy - H / 2 / scale); gy <= cy + H / 2 / scale; gy++) line(0, sy(gy), W, sy(gy));

  // zone labels at the centroid of their objects
  const zones = new Map<string, { x: number; y: number; n: number }>();
  for (const o of objects) if (o.zone && o.x != null && o.y != null) {
    const z = zones.get(o.zone) ?? { x: 0, y: 0, n: 0 };
    zones.set(o.zone, { x: z.x + o.x, y: z.y + o.y, n: z.n + 1 });
  }
  ctx.font = "12px system-ui";
  ctx.textAlign = "center";
  for (const [name, z] of zones) {
    const zx = sx(z.x / z.n), zy = sy(z.y / z.n);
    ctx.strokeStyle = "#26314a";
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(zx, zy, 34, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#5d6b8c";
    ctx.fillText(name.toUpperCase(), zx, zy + 52);
  }

  // target line
  const t = state.target;
  if (t) {
    ctx.strokeStyle = t.mode === "zone" ? "#ffb000" : "#39ff14";
    ctx.setLineDash([6, 5]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(sx(state.pose.x), sy(state.pose.y));
    ctx.lineTo(sx(t.x), sy(t.y));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // objects, fading with age
  const now = Date.now();
  ctx.textAlign = "left";
  for (const o of objects) {
    if (o.x == null || o.y == null) continue;
    const ageMin = (now - o.lastSeenAt) / 60000;
    const alpha = Math.max(0.25, 1 - ageMin / 30);
    const x = sx(o.x), y = sy(o.y);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = o.status === "moved" ? "#ffb000" : o.status === "held" ? "#5aa9ff" : "#39ff14";
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    if (o.status === "held") ctx.stroke();
    else ctx.fill();
    ctx.fillStyle = "#e6e9f0";
    ctx.font = "13px system-ui";
    ctx.fillText(o.label, x + 11, y + 4);
    ctx.globalAlpha = 1;
  }

  // wearer: position dot, heading cone (70 deg field of view)
  const px = sx(state.pose.x), py = sy(state.pose.y);
  const heading = ((state.pose.headingDeg - 90) * Math.PI) / 180;
  const half = (35 * Math.PI) / 180;
  const len = 2.2 * scale;
  ctx.fillStyle = "rgba(90,169,255,.18)";
  ctx.beginPath();
  ctx.moveTo(px, py);
  ctx.arc(px, py, len, heading - half, heading + half);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = "#5aa9ff";
  ctx.beginPath();
  ctx.arc(px, py, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#8a93a6";
  ctx.font = "11px system-ui";
  ctx.fillText(`${(span).toFixed(0)} m across`, 10, H - 10);
}

setInterval(() => {
  drawMap();
  renderLedger();
}, 5000);
renderState();
