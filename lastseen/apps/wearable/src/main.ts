import { connectTracker } from "@lastseen/shared/connect";

const params = new URLSearchParams(location.search);
const device = params.get("device") ?? "demo";
const token = params.get("token") ?? localStorage.getItem("lastseen.token") ?? "";
if (params.get("token")) localStorage.setItem("lastseen.token", token);

const statusEl = document.getElementById("status")!;

document.getElementById("start")!.addEventListener("click", () => {
  const conn = connectTracker({
    host: location.host,
    device,
    token,
    onOpen: () => {
      statusEl.textContent = "connected";
      conn.send({ type: "hello", role: "wearable" });
    },
    onClose: () => (statusEl.textContent = "disconnected"),
    onMessage: (msg) => {
      if (msg.type === "reply") statusEl.textContent = msg.text;
    },
  });
});
