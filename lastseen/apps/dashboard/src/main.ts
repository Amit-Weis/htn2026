import { connectTracker } from "@lastseen/shared/connect";

const params = new URLSearchParams(location.search);
const device = params.get("device") ?? "demo";
const token = params.get("token") ?? localStorage.getItem("lastseen.token") ?? "";
if (params.get("token")) localStorage.setItem("lastseen.token", token);

const out = document.getElementById("out")!;
const conn = connectTracker({
  host: location.host,
  device,
  token,
  onOpen: () => conn.send({ type: "hello", role: "dashboard" }),
  onState: (s) => (out.textContent = JSON.stringify(s, null, 2)),
  onMessage: (m) => console.log(m),
});
