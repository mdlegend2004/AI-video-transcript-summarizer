#!/usr/bin/env python3
"""
cli.py  —  Command-line interface for the YouTube Video Summarizer
Usage: python cli.py
"""
import sys
import os

try:
    from config import OPENAI_API_KEY
except ImportError:
    OPENAI_API_KEY = ""
try:
    from config import YTDLP_COOKIES_FILE
except ImportError:
    YTDLP_COOKIES_FILE = ""
try:
    from config import YTDLP_COOKIES_FROM_BROWSER
except ImportError:
    YTDLP_COOKIES_FROM_BROWSER = ""

from summarizer_core import SUMMARY_STYLES, summarize_youtube_url


def print_banner():
    print("\n" + "═" * 60)
    print("  📺  YouTube Video Summarizer")
    print("═" * 60)


def get_url() -> str:
    print("\nPaste your YouTube link below:")
    print("─" * 60)
    url = input("  🔗  URL : ").strip()
    if not url:
        print("❌  No URL entered. Exiting.")
        sys.exit(1)
    return url


def get_summary_style() -> tuple[str, dict]:
    print("\n" + "─" * 5)
    print("  Choose summary type:\n")
    for key, style in SUMMARY_STYLES.items():
        print(f"    {key}.  {style['label']}")
    print("\n" + "─" * 1)
    while True:
        choice = input("  Enter number (1-5) : ").strip()
        if choice in SUMMARY_STYLES:
            selected = SUMMARY_STYLES[choice]
            print(f"\n✅  Selected: {selected['label']}")
            return choice, selected
        print("  ⚠️   Invalid choice. Please enter a number between 1 and 5.")


def main():
    if not OPENAI_API_KEY:
        print("❌  No OpenAI API key found. Add it to config.py")
        sys.exit(1)

    print_banner()
    url = get_url()
    style_key, _ = get_summary_style()

    try:
        result = summarize_youtube_url(
            url=url,
            style_key=style_key,
            openai_api_key=OPENAI_API_KEY,
            cookies_file=YTDLP_COOKIES_FILE,
            cookies_browser=YTDLP_COOKIES_FROM_BROWSER,
        )
    except Exception as exc:
        print(f"\n❌  Error: {exc}")
        sys.exit(1)

    title       = result["title"]
    summary     = result["summary"]
    style_label = result["style_label"]

    print("\n" + "═" * 60)
    print(f"📺  {title}")
    print(f"📝  {style_label}")
    print("═" * 60)
    print(summary)
    print("═" * 60)

    safe_title = "".join(c if c.isalnum() or c in " _-" else "_" for c in title)[:50]
    style_tag  = style_label.replace(" ", "_").lower()
    out_file   = f"summary_{safe_title}_{style_tag}.txt"

    with open(out_file, "w", encoding="utf-8") as f:
        f.write(f"Title  : {title}\n")
        f.write(f"URL    : {url}\n")
        f.write(f"Style  : {style_label}\n")
        f.write("═" * 60 + "\n\n")
        f.write(summary + "\n")

    print(f"\n💾  Saved to: {out_file}")


if __name__ == "__main__":
    main()
