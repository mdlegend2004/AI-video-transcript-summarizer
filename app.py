"""
app.py  —  Flask web interface for the YouTube Video Summarizer
Usage: python app.py
Then open: http://localhost:5000
"""
from __future__ import annotations

import json
import os
import queue
import threading
import uuid
from datetime import datetime
from pathlib import Path

from flask import Flask, Response, jsonify, render_template, request, send_from_directory

try:
    from config import (
        OPENAI_API_KEY,
        FLASK_DEBUG,
        FLASK_HOST,
        FLASK_PORT,
        SECRET_KEY,
    )
    try:
        from config import YTDLP_COOKIES_FILE
    except ImportError:
        YTDLP_COOKIES_FILE = ""
    try:
        from config import YTDLP_COOKIES_FROM_BROWSER
    except ImportError:
        YTDLP_COOKIES_FROM_BROWSER = ""
except ImportError:
    OPENAI_API_KEY          = os.getenv("OPENAI_API_KEY", "")
    YTDLP_COOKIES_FILE      = ""
    YTDLP_COOKIES_FROM_BROWSER = ""
    FLASK_HOST              = "0.0.0.0"
    FLASK_PORT              = 5000
    FLASK_DEBUG             = False
    SECRET_KEY              = "dev-secret"

from summarizer_core import SUMMARY_STYLES, summarize_youtube_url

# ── app setup ─────────────────────────────────────────────────────────────────
app = Flask(__name__)
app.secret_key = SECRET_KEY

SUMMARIES_DIR = Path("summaries")
SUMMARIES_DIR.mkdir(exist_ok=True)

# In-memory job store  { job_id: { status, logs, result, error } }
_jobs: dict[str, dict] = {}
_job_queues: dict[str, queue.Queue] = {}


# ── helpers ───────────────────────────────────────────────────────────────────

def _run_job(job_id: str, url: str, style_key: str) -> None:
    """Background thread: run the full pipeline and push SSE events."""
    q = _job_queues[job_id]
    _jobs[job_id]["status"] = "running"

    def push(msg: str) -> None:
        _jobs[job_id]["logs"].append(msg)
        q.put(("log", msg))

    try:
        result = summarize_youtube_url(
            url=url,
            style_key=style_key,
            openai_api_key=OPENAI_API_KEY,
            cookies_file=YTDLP_COOKIES_FILE,
            cookies_browser=YTDLP_COOKIES_FROM_BROWSER,
            progress_cb=push,
        )
        # Persist summary to disk
        ts         = datetime.now().strftime("%Y%m%d_%H%M%S")
        safe_title = "".join(c if c.isalnum() or c in " _-" else "_" for c in result["title"])[:40]
        fname      = f"{ts}_{safe_title}.json"
        fpath      = SUMMARIES_DIR / fname
        with open(fpath, "w", encoding="utf-8") as f:
            json.dump({**result, "job_id": job_id, "saved_at": ts}, f, ensure_ascii=False, indent=2)

        _jobs[job_id]["status"] = "done"
        _jobs[job_id]["result"] = result
        q.put(("done", result))
    except Exception as exc:
        _jobs[job_id]["status"] = "error"
        _jobs[job_id]["error"]  = str(exc)
        q.put(("error", str(exc)))
    finally:
        q.put(("end", None))


# ── routes ────────────────────────────────────────────────────────────────────

@app.route("/")
def index():
    return render_template("index.html", styles=SUMMARY_STYLES)


@app.route("/api/summarize", methods=["POST"])
def api_summarize():
    data      = request.get_json(force=True)
    url       = (data.get("url") or "").strip()
    style_key = str(data.get("style_key", "1")).strip()

    if not url:
        return jsonify({"error": "URL is required"}), 400
    if style_key not in SUMMARY_STYLES:
        return jsonify({"error": "Invalid style_key"}), 400
    if not OPENAI_API_KEY:
        return jsonify({"error": "No OpenAI API key configured in config.py"}), 500

    job_id = str(uuid.uuid4())
    _jobs[job_id] = {"status": "queued", "logs": [], "result": None, "error": None}
    _job_queues[job_id] = queue.Queue()

    t = threading.Thread(target=_run_job, args=(job_id, url, style_key), daemon=True)
    t.start()

    return jsonify({"job_id": job_id})


@app.route("/api/stream/<job_id>")
def api_stream(job_id: str):
    """Server-Sent Events stream for a running job."""
    if job_id not in _jobs:
        return jsonify({"error": "Job not found"}), 404

    def generate():
        q = _job_queues.get(job_id)
        if q is None:
            yield f"data: {json.dumps({'type':'error','payload':'Job queue missing'})}\n\n"
            return

        while True:
            try:
                event_type, payload = q.get(timeout=60)
            except queue.Empty:
                yield f"data: {json.dumps({'type':'ping'})}\n\n"
                continue

            if event_type == "log":
                yield f"data: {json.dumps({'type':'log','payload':payload})}\n\n"
            elif event_type == "done":
                yield f"data: {json.dumps({'type':'done','payload':payload})}\n\n"
                return          # stop generator; client closes SSE
            elif event_type == "error":
                yield f"data: {json.dumps({'type':'error','payload':payload})}\n\n"
                return          # stop generator
            elif event_type == "end":
                return          # fallback stop (should not normally reach here)

    return Response(generate(), mimetype="text/event-stream",
                    headers={
                        "Cache-Control": "no-cache",
                        "X-Accel-Buffering": "no",
                        "Connection": "keep-alive",
                    })


@app.route("/api/job/<job_id>")
def api_job_status(job_id: str):
    job = _jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found"}), 404
    return jsonify(job)


@app.route("/api/history")
def api_history():
    files = sorted(SUMMARIES_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    history = []
    for f in files[:20]:
        try:
            with open(f, encoding="utf-8") as fh:
                data = json.load(fh)
            history.append({
                "title":       data.get("title", "Unknown"),
                "url":         data.get("url", ""),
                "style_label": data.get("style_label", ""),
                "saved_at":    data.get("saved_at", ""),
                "file":        f.name,
                "word_count":  data.get("transcript_word_count", 0),
            })
        except Exception:
            pass
    return jsonify(history)


@app.route("/api/history/<filename>")
def api_history_detail(filename: str):
    fpath = SUMMARIES_DIR / filename
    if not fpath.exists() or not fpath.is_file():
        return jsonify({"error": "Not found"}), 404
    with open(fpath, encoding="utf-8") as f:
        return jsonify(json.load(f))


# ── main ──────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print(f"🚀  Starting web server at http://{FLASK_HOST}:{FLASK_PORT}")
    app.run(host=FLASK_HOST, port=FLASK_PORT, debug=FLASK_DEBUG, threaded=True)