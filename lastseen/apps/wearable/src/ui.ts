/** Tiny DOM helpers and the shared dark style for the HUD start page. */

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Partial<Record<string, string>> | string | null = null,
  ...kids: Array<Node | string | null | undefined>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (typeof attrs === "string") el.className = attrs;
  else if (attrs) for (const [k, v] of Object.entries(attrs)) if (v !== undefined) el.setAttribute(k, v);
  for (const k of kids) if (k != null) el.append(k);
  return el;
}

export function button(label: string, onClick: () => void | Promise<void>, cls = ""): HTMLButtonElement {
  const b = h("button", cls, label);
  b.addEventListener("click", () => void onClick());
  return b;
}

let styled = false;
export function injectStyle() {
  if (styled || document.getElementById("app-style")) return;
  styled = true;
  const s = document.createElement("style");
  s.id = "app-style";
  s.textContent = `
    html, body { margin: 0; min-height: 100%; background: #000; color: #e8ecf3; font: 16px/1.45 system-ui, sans-serif; }
    .page { max-width: 760px; margin: 0 auto; padding: 16px 16px 48px; }
    h1 { font-size: 22px; margin: 4px 0 2px; } h2 { font-size: 15px; margin: 22px 0 8px; color: #9aa6bd; text-transform: uppercase; letter-spacing: .05em; }
    .sub { color: #8a93a6; font-size: 13px; }
    .card { background: #10141c; border: 1px solid #232a3a; border-radius: 12px; padding: 12px 14px; margin: 10px 0; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; margin: 8px 0; }
    button, .btn { background: #1d2740; color: #e8ecf3; border: 1px solid #33406a; border-radius: 10px; padding: 10px 14px; font-size: 15px; text-decoration: none; }
    button.primary { background: #0d3a1c; border-color: #39ff14; color: #b8ffa8; } button.danger { border-color: #6a2b2b; color: #ff8a8a; }
    button:disabled { opacity: .45; }
    input, select { background: #0a0d13; color: #e8ecf3; border: 1px solid #2c3550; border-radius: 8px; padding: 10px; font-size: 15px; width: 100%; box-sizing: border-box; }
    label { display: block; margin: 10px 0 4px; color: #9aa6bd; font-size: 13px; }
    pre { background: #06080c; border: 1px solid #1c2233; border-radius: 8px; padding: 10px; overflow: auto; max-height: 320px; font-size: 12px; margin: 8px 0; white-space: pre-wrap; word-break: break-word; }
    .pill { display: inline-block; padding: 2px 10px; border-radius: 999px; font-size: 13px; background: #1c2230; }
    .pill.ok { background: #0e3a1c; color: #39ff14; } .pill.bad { background: #3a1616; color: #ff6b6b; } .pill.warn { background: #3a2e10; color: #ffb000; } .pill.run { background: #10284a; color: #7db4ff; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; } td, th { border-bottom: 1px solid #1c2233; padding: 4px 6px; text-align: left; }
    a { color: #7db4ff; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
  `;
  document.head.appendChild(s);
}
