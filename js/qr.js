// Prikaz QR koda u programu (SVG) – knjižnica qrcode-generator (MIT), učitava se kad zatreba.
let loading = null;
export function loadQr() {
  if (window.qrcode) return Promise.resolve(window.qrcode);
  if (!loading) {
    loading = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = new URL("./vendor/qrcode-generator.js", import.meta.url).href;
      s.onload = () => res(window.qrcode);
      s.onerror = () => { loading = null; rej(new Error("QR knjižnica se ne može učitati.")); };
      document.head.append(s);
    });
  }
  return loading;
}

// SVG element s QR kodom (sadržaj = točno zadani tekst, npr. "Keg-023")
export async function qrSvg(text, px = 160) {
  const qrcode = await loadQr();
  const q = qrcode(0, "M");
  q.addData(String(text));
  q.make();
  const n = q.getModuleCount(), quiet = 2, size = n + quiet * 2;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
  svg.setAttribute("width", px); svg.setAttribute("height", px);
  svg.setAttribute("shape-rendering", "crispEdges");
  const bg = document.createElementNS(ns, "rect");
  bg.setAttribute("width", size); bg.setAttribute("height", size); bg.setAttribute("fill", "#fff");
  svg.append(bg);
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", d); path.setAttribute("fill", "#000");
  svg.append(path);
  return svg;
}
