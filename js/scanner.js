// Skeniranje QR koda kamerom (mobitel/tablet/laptop).
// Koristi ugrađeni BarcodeDetector (Chrome, Edge, Android) ili, ako ga nema (Safari, Firefox), knjižnicu jsQR.
import { h } from "./ui.js";

let jsqrLoading = null;
function loadJsQR() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  if (!jsqrLoading) {
    jsqrLoading = new Promise((res, rej) => {
      const s = document.createElement("script");
      s.src = new URL("./vendor/jsQR.js", import.meta.url).href;
      s.onload = () => res(window.jsQR);
      s.onerror = () => { jsqrLoading = null; rej(new Error("Čitač QR koda se ne može učitati.")); };
      document.head.append(s);
    });
  }
  return jsqrLoading;
}

export function beep(ok = true) {
  try {
    if (navigator.vibrate) navigator.vibrate(ok ? 60 : [120, 60, 120]);
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return;
    const ctx = beep.ctx || (beep.ctx = new C());
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = ok ? 1250 : 300;
    g.gain.value = 0.08;
    o.connect(g); g.connect(ctx.destination);
    o.start(); o.stop(ctx.currentTime + (ok ? 0.09 : 0.25));
  } catch { /* zvuk nije obavezan */ }
}

export class Scanner {
  constructor(onCode) {
    this.onCode = onCode;
    this.video = h("video", { playsinline: true, muted: true, autoplay: true });
    this.frame = h("div", { class: "scan-frame" });
    this.el = h("div", { class: "scanner hidden" }, this.video, this.frame);
    this.canvas = document.createElement("canvas");
    this.running = false;
    this.last = { code: null, t: 0 };
  }

  async start() {
    if (this.running) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia)
      throw new Error("Ovaj preglednik ne dopušta kameru (stranica mora biti otvorena preko https://).");
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
    this.video.srcObject = this.stream;
    await this.video.play().catch(() => {});
    this.el.classList.remove("hidden");
    this.running = true;
    if ("BarcodeDetector" in window) {
      try {
        const fm = await window.BarcodeDetector.getSupportedFormats();
        if (fm.includes("qr_code")) this.detector = new window.BarcodeDetector({ formats: ["qr_code"] });
      } catch { this.detector = null; }
    }
    if (!this.detector) await loadJsQR();
    this.loop();
  }

  stop() {
    this.running = false;
    clearTimeout(this.timer);
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.video.srcObject = null;
    this.el.classList.add("hidden");
  }

  flash(ok) {
    this.frame.classList.remove("ok", "bad");
    void this.frame.offsetWidth;
    this.frame.classList.add(ok ? "ok" : "bad");
  }

  async loop() {
    if (!this.running) return;
    let code = null;
    try {
      const v = this.video;
      if (v.readyState >= 2 && v.videoWidth) {
        if (this.detector) {
          const r = await this.detector.detect(v);
          if (r && r.length) code = r[0].rawValue;
        } else if (window.jsQR) {
          const w = Math.min(v.videoWidth, 800), hh = Math.round(v.videoHeight * w / v.videoWidth);
          this.canvas.width = w; this.canvas.height = hh;
          const cx = this.canvas.getContext("2d", { willReadFrequently: true });
          cx.drawImage(v, 0, 0, w, hh);
          const img = cx.getImageData(0, 0, w, hh);
          const r = window.jsQR(img.data, w, hh, { inversionAttempts: "dontInvert" });
          if (r) code = r.data;
        }
      }
    } catch (e) { console.warn(e); }
    if (code) {
      const now = Date.now();
      if (code !== this.last.code || now - this.last.t > 2500) {
        this.last = { code, t: now };
        try { this.onCode(code); } catch (e) { console.error(e); }
      }
    }
    this.timer = setTimeout(() => this.loop(), 160);
  }
}
