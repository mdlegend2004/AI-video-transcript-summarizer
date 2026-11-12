# ─────────────────────────────────────────────────────────────────────────────
#  config.py  —  API keys & optional cookie settings
# ─────────────────────────────────────────────────────────────────────────────

OPENAI_API_KEY = "sk-..."  # ← paste your OpenAI key here
# Optional: path to a Netscape-format cookies.txt file exported from your browser
YTDLP_COOKIES_FILE = ""  # e.g. "www.youtube.com_cookies.txt"

# Optional: let yt-dlp pull cookies directly from an installed browser
# Values: "chrome", "firefox", "edge", "safari", "brave", "opera"
# You can also specify a profile:  "chrome:Default"
YTDLP_COOKIES_FROM_BROWSER = ""    # e.g. "chrome"

# Flask web server settings
FLASK_HOST = "0.0.0.0"
FLASK_PORT = 5000
FLASK_DEBUG = False
SECRET_KEY = "change-me"
