#!/usr/bin/env python3
"""
Generate a SoundExchange Report of Use from Icecast's playlist.log.

Output is pipe-delimited with ^-wrapped uppercase strings, matching
SoundExchange's required format.

Usage:
    python3 soundexchange_report.py 2026-11           # November 2026
    python3 soundexchange_report.py 2026-11 --isrc    # also look up ISRCs via MusicBrainz
"""

import html
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict
from datetime import datetime

PLAYLIST_LOG = os.path.join(os.path.dirname(__file__), "logs", "playlist.log")
MUSIC_DIR = os.path.join(os.path.dirname(__file__), "music")
SERVICE_NAME = "MAZES RADIO"
STATION_SHORT = "MAZESRADIO"

HEADER = [
    "NAME_OF_SERVICE",
    "TRANSMISSION_CATEGORY",
    "FEATURED_ARTIST",
    "SOUND_RECORDING_TITLE",
    "ISRC",
    "ALBUM_TITLE",
    "MARKETING_LABEL",
    "ACTUAL_TOTAL_PERFORMANCES",
]


def parse_log(year, month):
    entries = []
    with open(PLAYLIST_LOG, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            parts = line.split("|", 3)
            if len(parts) < 4:
                continue
            date_str, _mount, listeners_str, raw_title = parts
            try:
                dt = datetime.strptime(date_str, "%d/%b/%Y:%H:%M:%S %z")
            except ValueError:
                continue
            if dt.year != year or dt.month != month:
                continue
            listeners = int(listeners_str) if listeners_str.strip().isdigit() else 0
            title_decoded = html.unescape(raw_title.strip())
            if " - " in title_decoded:
                dash = title_decoded.index(" - ")
                artist = title_decoded[:dash].strip()
                title = title_decoded[dash + 3 :].strip()
            else:
                artist = ""
                title = title_decoded
            entries.append((dt, artist, title, listeners))
    return entries


def mp3_tags(artist, title):
    candidate = f"{artist}- {title}.mp3"
    path = None
    try:
        for name in os.listdir(MUSIC_DIR):
            if name.lower() == candidate.lower():
                path = os.path.join(MUSIC_DIR, name)
                break
    except OSError:
        return {}
    if not path:
        return {}
    try:
        out = subprocess.run(
            [
                "ffprobe",
                "-v",
                "quiet",
                "-print_format",
                "json",
                "-show_entries",
                "format_tags",
                path,
            ],
            capture_output=True,
            text=True,
            timeout=5,
        ).stdout
        tags = json.loads(out).get("format", {}).get("tags", {})
        t = {k.lower(): v for k, v in tags.items()}
        return {
            "album": t.get("album", ""),
            "label": t.get("label") or t.get("organization") or t.get("publisher") or "",
            "isrc": t.get("isrc", ""),
        }
    except Exception:
        return {}


def musicbrainz_isrc(artist, title):
    """Query MusicBrainz for an ISRC. Returns empty string if not found."""
    query = f'artist:"{artist}" AND recording:"{title}"'
    url = "https://musicbrainz.org/ws/2/recording/?" + urllib.parse.urlencode(
        {
            "query": query,
            "fmt": "json",
            "limit": 5,
        }
    )
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "mazesradio-report/1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            data = json.loads(resp.read())
        for rec in data.get("recordings", []):
            if rec.get("isrcs"):
                return rec["isrcs"][0]
    except Exception:
        pass
    return ""


def encode_field(val):
    if isinstance(val, int):
        return str(val)
    # Uppercase, strip pipe and caret, wrap in carets
    cleaned = re.sub(r"[|^]", "", str(val).upper())
    return f"^{cleaned}^"


def main():
    fetch_isrc = "--isrc" in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith("--")]

    if not args:
        print("Usage: soundexchange_report.py YYYY-MM [--isrc]", file=sys.stderr)
        sys.exit(1)

    year, month = map(int, args[0].split("-"))
    entries = parse_log(year, month)

    if not entries:
        print(f"No entries found for {year}-{month:02d}.", file=sys.stderr)
        sys.exit(1)

    print(f"# {len(entries)} plays in {year}-{month:02d}", file=sys.stderr)

    # Sum listener-performances per song (each listener × each play = 1 performance)
    performances = defaultdict(int)
    for _, artist, title, listeners in entries:
        performances[(artist, title)] += max(listeners, 1)  # count at least 1 per play

    # Collect metadata
    rows = []
    for (artist, title), perf_count in sorted(performances.items(), key=lambda x: (-x[1], x[0][0])):
        tags = mp3_tags(artist, title)
        isrc = tags.get("isrc", "")
        if fetch_isrc and not isrc:
            print(f"  MusicBrainz lookup: {artist} - {title}", file=sys.stderr)
            isrc = musicbrainz_isrc(artist, title)
            time.sleep(1)  # MusicBrainz rate limit: 1 req/sec
        rows.append(
            [
                SERVICE_NAME,
                "A",
                artist,
                title,
                isrc,
                tags.get("album", ""),
                tags.get("label", ""),
                perf_count,
            ]
        )

    # Build output
    start_str = datetime(year, month, 1).strftime("%d%m%Y")
    import calendar

    last_day = calendar.monthrange(year, month)[1]
    end_str = datetime(year, month, last_day).strftime("%d%m%Y")
    filename = f"{STATION_SHORT}{start_str}-{end_str}_A.txt"

    lines = ["|".join(encode_field(f) for f in HEADER)]
    for row in rows:
        lines.append("|".join(encode_field(f) for f in row))

    output = "\n".join(lines)
    sys.stdout.write(output + "\n")

    print(f"# Save as: {filename}", file=sys.stderr)


if __name__ == "__main__":
    main()
