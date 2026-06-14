"""Post a Components V2 release card to the #update-logs Discord channel.

Run by .github/workflows/discord-release.yml on every published release.
Reads everything from env vars; no args.
"""
import os, json, urllib.request, urllib.error

TOKEN = os.environ["DISCORD_TOKEN"]
TAG = os.environ.get("TAG", "").strip()
NAME = (os.environ.get("RELEASE_NAME") or TAG).strip() or "New release"
BODY = (os.environ.get("RELEASE_BODY") or "").strip()
RELEASE_URL = os.environ.get("RELEASE_URL", "").strip()

CHANNEL = "1499511470717669396"  # #update-logs (Ultimate AMV Toolkit guild)
DOWNLOAD_URL = "https://github.com/ElishaPervez/Ultimate-AMV/releases/latest/download/Ultimate.AMV_x64-setup.exe"
IS_COMPONENTS_V2 = 1 << 15

# Discord text-display components cap at 4000 chars; keep release notes well under.
if len(BODY) > 3500:
    BODY = BODY[:3490].rstrip() + "\n…(truncated — see full notes via the button below)"
if not BODY:
    BODY = "_No release notes were provided for this build._"

container_children = [
    {"type": 10, "content": f"# \U0001F389 {NAME} is out!"},
    {"type": 10, "content": f"-# Release `{TAG}`"},
    {"type": 14, "divider": True, "spacing": 2},
    {"type": 10, "content": f"**\U0001F4CB What's new**\n{BODY}"},
    {"type": 14, "divider": True, "spacing": 1},
    {"type": 10, "content": "## ⬇️ Get it"},
]

# button row: always offer download; add "View release" only if we have the URL
buttons = [{"type": 2, "style": 5, "label": "Download latest build", "url": DOWNLOAD_URL}]
if RELEASE_URL:
    buttons.append({"type": 2, "style": 5, "label": "View release notes", "url": RELEASE_URL})
container_children.append({"type": 1, "components": buttons})

container_children += [
    {"type": 14, "divider": True, "spacing": 2},
    {"type": 10, "content": "-# Ultimate AMV · auto-posted on release"},
]

payload = {
    "flags": IS_COMPONENTS_V2,
    "components": [{"type": 17, "accent_color": 0x57CE00, "components": container_children}],
    "allowed_mentions": {"parse": []},  # never ping anyone
}

req = urllib.request.Request(
    f"https://discord.com/api/v10/channels/{CHANNEL}/messages",
    data=json.dumps(payload).encode("utf-8"),
    method="POST",
    headers={
        "Authorization": f"Bot {TOKEN}",
        "Content-Type": "application/json",
        "User-Agent": "DiscordBot (https://github.com/ElishaPervez/Ultimate-AMV, 1.0)",
    },
)
try:
    with urllib.request.urlopen(req) as r:
        print("Posted to #update-logs:", r.status, json.loads(r.read()).get("id"))
except urllib.error.HTTPError as e:
    print("Discord API error", e.code)
    print(e.read().decode())
    raise SystemExit(1)
