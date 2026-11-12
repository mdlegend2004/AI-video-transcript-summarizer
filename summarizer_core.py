"""
summarizer_core.py  —  shared pipeline (CLI + web)

Transcript strategy:
  1. youtube-transcript-api  — grabs existing captions, fastest, no audio needed
  2. yt-dlp + Whisper        — fallback when no captions exist
"""
from __future__ import annotations

import http.cookiejar
import math
import os
import re
import shutil
import tempfile
from pathlib import Path
from typing import Callable

try:
    import yt_dlp
except ImportError:
    raise ImportError("run: pip install yt-dlp")

try:
    from openai import OpenAI
except ImportError:
    raise ImportError("run: pip install openai")

try:
    import requests
    from youtube_transcript_api import YouTubeTranscriptApi
    _HAS_TRANSCRIPT_API = True
except ImportError:
    _HAS_TRANSCRIPT_API = False

# ── constants ─────────────────────────────────────────────────────────────────
WHISPER_MODEL = "whisper-1"
GPT_MODEL     = "gpt-4o-mini"
MAX_CHARS     = 12_000
CHUNK_BYTES   = 24 * 1024 * 1024

SUMMARY_STYLES: dict[str, dict] = {
    "1": {
        "label": "Professional Report",
        "system": "You are a professional business analyst. Summarise the transcript in a formal, professional tone suitable for business stakeholders.",
        "user_suffix": "Write a professional report with an executive summary, key findings, and recommendations.",
    },
    "2": {
        "label": "Concise",
        "system": "You are an expert at summarising content as briefly as possible without losing meaning.",
        "user_suffix": "Write a concise summary in 3-5 bullet points only. Be brief and to the point.",
    },
    "3": {
        "label": "Detailed Analysis",
        "system": "You are an expert analyst. Provide a thorough, in-depth analysis of the transcript covering all key ideas, arguments, and insights.",
        "user_suffix": "Write a detailed analysis covering all major points, supporting arguments, examples mentioned, and any conclusions drawn.",
    },
    "4": {
        "label": "Structured Document",
        "system": "You are a technical writer. Organise the transcript content into a well-structured document with clear headings and sections.",
        "user_suffix": "Write a structured document with clear headings (Introduction, Main Topics, Key Points, Conclusion). Use subheadings where relevant.",
    },
    "5": {
        "label": "Conclusion-Focused Brief",
        "system": "You are an expert at identifying the core conclusions and final takeaways from content.",
        "user_suffix": "Focus only on the conclusions, final takeaways, and actionable insights from this video. Skip background and context.",
    },
}


# ── helpers ───────────────────────────────────────────────────────────────────

def _log(msg: str, cb: Callable | None) -> None:
    try:
        print(msg, flush=True)
    except UnicodeEncodeError:
        print(msg.encode("ascii", "replace").decode(), flush=True)
    if cb:
        cb(msg)


def _extract_video_id(url: str) -> str | None:
    m = re.search(r"(?:v=|/v/|youtu\.be/|/embed/|/shorts/)([A-Za-z0-9_-]{11})", url)
    return m.group(1) if m else None


def _make_session(cookies_file: str = "") -> "requests.Session":
    """Build a requests.Session, optionally loading a Netscape cookies.txt file."""
    session = requests.Session()
    session.headers.update({
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/124.0.0.0 Safari/537.36"
        ),
        "Accept-Language": "en-US,en;q=0.9",
    })
    if cookies_file and os.path.exists(cookies_file):
        jar = http.cookiejar.MozillaCookieJar(cookies_file)
        try:
            jar.load(ignore_discard=True, ignore_expires=True)
            session.cookies.update(jar)
        except Exception:
            pass
    return session


# ── Strategy 1: captions ──────────────────────────────────────────────────────

def _fetch_captions(video_id: str, cookies_file: str,
                    cb: Callable | None) -> str | None:
    if not _HAS_TRANSCRIPT_API:
        return None
    try:
        _log("📄  Fetching YouTube captions…", cb)
        session = _make_session(cookies_file)
        api     = YouTubeTranscriptApi(http_client=session)

        transcript_list = api.list(video_id)

        # priority: manual English → auto English → any language translated to English
        transcript = None
        try:
            transcript = transcript_list.find_manually_created_transcript(
                ["en", "en-US", "en-GB", "en-IN"]
            )
        except Exception:
            pass

        if transcript is None:
            try:
                transcript = transcript_list.find_generated_transcript(
                    ["en", "en-US", "en-GB", "en-IN"]
                )
            except Exception:
                pass

        if transcript is None:
            # try any available language, translate to English
            try:
                for t in transcript_list:
                    transcript = t.translate("en")
                    break
            except Exception:
                pass

        if transcript is None:
            _log("⚠️  No captions found — will download audio instead…", cb)
            return None

        fetched = transcript.fetch()
        # v1.x returns a FetchedTranscript; iterate snippets
        text = " ".join(
            getattr(s, "text", s.get("text", "") if isinstance(s, dict) else "")
            for s in fetched
        ).replace("\n", " ").strip()

        if len(text) < 50:
            return None

        _log(f"✅  Captions fetched ({len(text.split())} words)", cb)
        return text

    except Exception as e:
        err = str(e)
        if "disabled" in err.lower() or "no transcript" in err.lower():
            _log("⚠️  Captions disabled for this video — downloading audio…", cb)
        else:
            _log(f"⚠️  Caption fetch failed: {e} — downloading audio…", cb)
        return None


def _get_title_only(url: str, cookies_file: str, cookies_browser: str) -> str:
    """Fetch video title without downloading audio (used after caption success)."""
    opts = {
        "quiet": True, "no_warnings": True, "skip_download": True,
        "http_headers": {"User-Agent": "Mozilla/5.0"},
    }
    if cookies_file and os.path.exists(cookies_file):
        opts["cookiefile"] = cookies_file
    if cookies_browser:
        spec = cookies_browser.strip()
        if ":" in spec:
            b, p = spec.split(":", 1)
            opts["cookiesfrombrowser"] = (b.strip(), p.strip())
        else:
            opts["cookiesfrombrowser"] = (spec,)
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
            return info.get("title", "Unknown Title")
    except Exception:
        return "Unknown Title"


# ── Strategy 2: audio download ────────────────────────────────────────────────

def _download_audio(url: str, out_dir: str, cb: Callable | None,
                    cookies_file: str, cookies_browser: str) -> tuple[str, str, str]:
    _log("⬇️  Downloading audio…", cb)
    opts = {
        "format": "bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio[ext=opus]/bestaudio/best",
        "outtmpl": os.path.join(out_dir, "audio.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "http_headers": {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                "AppleWebKit/537.36 (KHTML, like Gecko) "
                "Chrome/124.0.0.0 Safari/537.36"
            )
        },
    }
    if cookies_file and os.path.exists(cookies_file):
        opts["cookiefile"] = cookies_file
    if cookies_browser:
        spec = cookies_browser.strip()
        if ":" in spec:
            b, p = spec.split(":", 1)
            opts["cookiesfrombrowser"] = (b.strip(), p.strip())
        else:
            opts["cookiesfrombrowser"] = (spec,)

    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info  = ydl.extract_info(url, download=True)
            title = info.get("title", "Unknown Title")
    except yt_dlp.utils.DownloadError as exc:
        raise ValueError(
            "YouTube blocked the audio download.\n\n"
            "Fix: \n"
            "1. Install the 'Get cookies.txt LOCALLY' Chrome extension\n"
            "2. Go to youtube.com while logged in\n"
            "3. Click the extension → Export → save as cookies.txt\n"
            "4. In config.py set:  YTDLP_COOKIES_FILE = r'C:\\path\\to\\cookies.txt'"
        ) from exc

    downloaded = list(Path(out_dir).glob("audio.*"))
    if not downloaded:
        raise FileNotFoundError("Download failed — no audio file found.")

    audio_path = str(downloaded[0])
    ext        = downloaded[0].suffix.lower().lstrip(".")
    size_mb    = os.path.getsize(audio_path) / 1_048_576
    _log(f"✅  Downloaded: '{title}'  ({size_mb:.1f} MB, .{ext})", cb)
    return audio_path, title, ext


def _split_audio(audio_path: str, out_dir: str, ext: str, cb: Callable | None) -> list[str]:
    total = os.path.getsize(audio_path)
    if total <= CHUNK_BYTES:
        return [audio_path]
    n = math.ceil(total / CHUNK_BYTES)
    _log(f"✂️   Splitting into {n} chunks…", cb)
    with open(audio_path, "rb") as f:
        raw = f.read()
    chunks, size = [], len(raw) // n
    for i in range(n):
        s, e = i * size, (i + 1) * size if i < n - 1 else len(raw)
        p = os.path.join(out_dir, f"chunk_{i+1:03d}.{ext}")
        with open(p, "wb") as f:
            f.write(raw[s:e])
        chunks.append(p)
        _log(f"    Chunk {i+1}/{n} — {(e-s)/1_048_576:.1f} MB", cb)
    return chunks


def _transcribe(client: OpenAI, chunks: list[str], cb: Callable | None) -> str:
    parts = []
    for i, path in enumerate(chunks, 1):
        mb = os.path.getsize(path) / 1_048_576
        _log(f"🎙️  Transcribing chunk {i}/{len(chunks)} ({mb:.1f} MB)…", cb)
        with open(path, "rb") as f:
            parts.append(client.audio.transcriptions.create(
                model=WHISPER_MODEL, file=f, response_format="text"
            ))
        _log(f"✅  Chunk {i}/{len(chunks)} done", cb)
    return "\n".join(parts)


# ── GPT summarise ─────────────────────────────────────────────────────────────

def _chunk_text(text: str) -> list[str]:
    words, out, cur, n = text.split(), [], [], 0
    for w in words:
        if n + len(w) + 1 > MAX_CHARS:
            out.append(" ".join(cur)); cur, n = [w], len(w)
        else:
            cur.append(w); n += len(w) + 1
    if cur:
        out.append(" ".join(cur))
    return out


def _summarise(client: OpenAI, transcript: str, title: str,
               style: dict, cb: Callable | None) -> str:
    _log(f"🧠  Generating [{style['label']}] summary…", cb)
    parts   = _chunk_text(transcript)
    results = []
    for i, part in enumerate(parts, 1):
        if len(parts) > 1:
            _log(f"    Part {i}/{len(parts)}…", cb)
        r = client.chat.completions.create(
            model=GPT_MODEL,
            messages=[
                {"role": "system", "content": style["system"]},
                {"role": "user",   "content": (
                    f"Video title: {title}\n\nTranscript:\n{part}\n\n{style['user_suffix']}"
                )},
            ],
            temperature=0.3,
        )
        results.append(r.choices[0].message.content)

    if len(results) == 1:
        return results[0]

    _log("    Merging parts…", cb)
    merged = client.chat.completions.create(
        model=GPT_MODEL,
        messages=[
            {"role": "system", "content": style["system"]},
            {"role": "user",   "content": (
                f"Video title: {title}\n\n"
                f"Combine these summaries into one:\n{style['user_suffix']}\n\n"
                + "\n\n---\n\n".join(results)
            )},
        ],
        temperature=0.3,
    )
    return merged.choices[0].message.content


# ── public entry point ────────────────────────────────────────────────────────

def summarize_youtube_url(
    url: str,
    style_key: str = "1",
    openai_api_key: str = "",
    cookies_file: str = "",
    cookies_browser: str = "",
    progress_cb: Callable[[str], None] | None = None,
) -> dict:
    if not openai_api_key:
        raise ValueError("No OpenAI API key provided.")
    if style_key not in SUMMARY_STYLES:
        raise ValueError(f"Invalid style key '{style_key}'.")

    client  = OpenAI(api_key=openai_api_key)
    style   = SUMMARY_STYLES[style_key]
    tmp_dir = tempfile.mkdtemp(prefix="yt_summary_")
    source  = "captions"

    try:
        video_id   = _extract_video_id(url)
        transcript = None
        title      = "Unknown Title"

        # ── 1. try captions ───────────────────────────────────────────────
        if video_id and _HAS_TRANSCRIPT_API:
            transcript = _fetch_captions(video_id, cookies_file, progress_cb)

        # ── 2. audio fallback ─────────────────────────────────────────────
        if not transcript:
            source = "whisper"
            audio_path, title, ext = _download_audio(
                url, tmp_dir, progress_cb, cookies_file, cookies_browser
            )
            chunks     = _split_audio(audio_path, tmp_dir, ext, progress_cb)
            transcript = _transcribe(client, chunks, progress_cb)
        else:
            title = _get_title_only(url, cookies_file, cookies_browser)

        wc = len(transcript.split())
        _log(f"✅  Transcript ready ({wc} words, via {source})", progress_cb)

        summary = _summarise(client, transcript, title, style, progress_cb)
        _log("🎉  Done!", progress_cb)

        return {
            "title":                 title,
            "url":                   url,
            "style_label":           style["label"],
            "summary":               summary,
            "transcript":            transcript,
            "transcript_word_count": wc,
            "transcript_source":     source,
        }
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)