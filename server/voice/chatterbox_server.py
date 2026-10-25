"""D.E.N.N.I.S.'s voice: Chatterbox (Resemble AI, MIT licence) on this computer's graphics card.

A small local HTTP server that the D.E.N.N.I.S. server (server/chatterbox.js) starts and talks to:
  GET  /health                                  -> {"ok": true, "device": "cuda", "loaded": [...]}
  POST /tts  {"text", "lang", "sample", "english"} -> audio/wav (16-bit mono)
  POST /warm {"models": ["multilingual", "turbo"]} -> loads (and on first use downloads) the models

Only D.E.N.N.I.S. may use it: it listens on 127.0.0.1, refuses other Host headers, and wants the
X-Dennis-Voice token he passes in. It exits when he does (its stdin closes).

The voice is cloned from a short sample (by default ~15 s of Kokoro's synthetic "Daniel"), prepared
once per model and reused. English can go to the faster Turbo model; every other language - and
English too, if Turbo isn't wanted - goes to the multilingual one. Chatterbox marks everything it
makes with Resemble AI's inaudible Perth watermark.
"""
import argparse
import io
import json
import os
import sys
import threading
import time
import traceback
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = os.environ.get("DENNIS_VOICE_TOKEN", "")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

import numpy as np  # noqa: E402
import torch  # noqa: E402


def parent_alive(pid):
    """Is that process still running? (Never os.kill(pid, 0) on Windows: there it terminates the process.)"""
    if os.name == "nt":
        import ctypes
        k32 = ctypes.windll.kernel32
        h = k32.OpenProcess(0x00100000, False, pid)  # SYNCHRONIZE
        if not h:
            return False
        try:
            return k32.WaitForSingleObject(h, 0) == 0x102  # WAIT_TIMEOUT: still running
        finally:
            k32.CloseHandle(h)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def cached(repo_id, patterns):
    """The model's folder in the local Hugging Face cache, if every file it needs is there (else None)."""
    try:
        from huggingface_hub import snapshot_download
        return snapshot_download(repo_id=repo_id, allow_patterns=patterns, local_files_only=True)
    except Exception:
        return None


class Voice:
    def __init__(self, device):
        self.device = device
        self.lock = threading.Lock()
        self.models = {}
        self.prepared = {}  # model name -> the sample its voice was prepared from
        self.langs = None

    def model(self, which):
        # Already downloaded? Load straight from the cache: from_pretrained asks the Hugging Face Hub
        # about every file first, which takes a minute through a company proxy. Online only if missing.
        if which not in self.models:
            if which == "turbo":
                from chatterbox.tts_turbo import ChatterboxTurboTTS, REPO_ID
                path = cached(REPO_ID, ["*.safetensors", "*.json", "*.txt", "*.pt", "*.model"])
                self.models[which] = ChatterboxTurboTTS.from_local(path, self.device) if path else ChatterboxTurboTTS.from_pretrained(device=self.device)
            else:
                from chatterbox.mtl_tts import ChatterboxMultilingualTTS, SUPPORTED_LANGUAGES, REPO_ID
                self.langs = set(SUPPORTED_LANGUAGES)
                path = cached(REPO_ID, ["ve.pt", "t3_mtl23ls_v2.safetensors", "s3gen.pt", "grapheme_mtl_merged_expanded_v1.json", "conds.pt", "Cangjie5_TC.json"])
                self.models[which] = ChatterboxMultilingualTTS.from_local(path, self.device) if path else ChatterboxMultilingualTTS.from_pretrained(device=self.device)
        return self.models[which]

    def warm(self, names, sample=""):
        for n in names:  # one at a time, so a line can be spoken between them (English as soon as Turbo is in)
            with self.lock:
                self.model(n)
            if sample and os.path.isfile(sample):
                # a first line nobody hears: the graphics card's one-time warm-up, and his voice prepared
                try:
                    self.speak("Ready.", "en", sample, "turbo" if n == "turbo" else "multilingual")
                except Exception:
                    traceback.print_exc()
        return sorted(self.models)

    def speak(self, text, lang, sample, english):
        with self.lock:
            turbo = lang == "en" and english == "turbo"
            name = "turbo" if turbo else "multilingual"
            m = self.model(name)
            if self.prepared.get(name) != sample:
                m.prepare_conditionals(sample, exaggeration=0.0 if turbo else 0.5)
                self.prepared[name] = sample
            t0 = time.time()
            if turbo:
                wav = m.generate(text)
            else:
                lid = lang if self.langs and lang in self.langs else "en"
                wav = m.generate(text, language_id=lid, exaggeration=0.5, cfg_weight=0.5)
            took = time.time() - t0
            a = wav.squeeze().detach().float().cpu().numpy()
            pcm = (np.clip(a, -1.0, 1.0) * 32767.0).astype("<i2")
            buf = io.BytesIO()
            with wave.open(buf, "wb") as w:
                w.setnchannels(1)
                w.setsampwidth(2)
                w.setframerate(int(m.sr))
                w.writeframes(pcm.tobytes())
            return buf.getvalue(), took, len(pcm) / float(m.sr), name


def make_handler(voice, port):
    hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a):  # quiet: D.E.N.N.I.S. keeps his own log
            pass

        def allowed(self):
            if self.headers.get("Host", "") not in hosts:
                return False
            return not TOKEN or self.headers.get("X-Dennis-Voice", "") == TOKEN

        def reply(self, code, body, ctype="application/json", extra=None):
            data = body if isinstance(body, bytes) else json.dumps(body).encode("utf-8")
            self.send_response(code)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(data)))
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if not self.allowed():
                return self.reply(403, {"error": "not for you"})
            if self.path == "/health":
                return self.reply(200, {"ok": True, "device": voice.device, "loaded": sorted(voice.models), "busy": voice.lock.locked(),
                                        "gpu": torch.cuda.get_device_name(0) if torch.cuda.is_available() else ""})
            self.reply(404, {"error": "unknown"})

        def do_POST(self):
            if not self.allowed():
                return self.reply(403, {"error": "not for you"})
            try:
                n = int(self.headers.get("Content-Length", "0") or 0)
                req = json.loads(self.rfile.read(min(n, 200_000)) or b"{}")
                if self.path == "/warm":
                    return self.reply(200, {"ok": True, "loaded": voice.warm(req.get("models") or ["multilingual"])})
                if self.path == "/tts":
                    text = str(req.get("text") or "").strip()[:1500]
                    sample = str(req.get("sample") or "")
                    if not text:
                        return self.reply(400, {"error": "nothing to say"})
                    if not os.path.isfile(sample):
                        return self.reply(400, {"error": f"no voice sample at {sample}"})
                    audio, took, secs, name = voice.speak(text, str(req.get("lang") or "en").lower(), sample, str(req.get("english") or "turbo"))
                    return self.reply(200, audio, "audio/wav", {"X-Took": f"{took:.2f}", "X-Seconds": f"{secs:.2f}", "X-Model": name})
                self.reply(404, {"error": "unknown"})
            except Exception as e:  # say what went wrong; D.E.N.N.I.S. falls back to another voice
                traceback.print_exc()
                self.reply(500, {"error": f"{type(e).__name__}: {e}"[:500]})

    return Handler


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=47850)
    ap.add_argument("--warm", default="", help="models to load at start, e.g. multilingual,turbo")
    ap.add_argument("--parent", type=int, default=0, help="exit when this process (D.E.N.N.I.S.) is gone")
    ap.add_argument("--sample", default="", help="his voice sample, prepared while warming up")
    args = ap.parse_args()
    device = "cuda" if torch.cuda.is_available() else ("mps" if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available() else "cpu")
    voice = Voice(device)

    # leave when D.E.N.N.I.S. does. (Not by blocking on stdin: on Windows a pending read on a pipe
    # freezes any library that starts a helper process meanwhile - model loading hung that way.)
    if args.parent:
        def watch_parent():
            while parent_alive(args.parent):
                time.sleep(2)
            os._exit(0)
        threading.Thread(target=watch_parent, daemon=True).start()

    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(voice, args.port))
    print(json.dumps({"listening": args.port, "device": device}), flush=True)
    if args.warm:
        threading.Thread(target=lambda: voice.warm([m for m in args.warm.split(",") if m], args.sample), daemon=True).start()
    server.serve_forever()


if __name__ == "__main__":
    main()
