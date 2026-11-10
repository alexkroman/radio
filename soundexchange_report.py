#!/usr/bin/env python3
"""
Generate a SoundExchange Report of Use from Icecast's playlist.log.

Usage:
    python3 soundexchange_report.py              # all plays
    python3 soundexchange_report.py 2026-11      # November 2026 only
    python3 soundexchange_report.py 2026-11 > report.csv
"""

import csv
import sys
import os
import json
import html
import subprocess
from datetime import datetime
from collections import defaultdict

PLAYLIST_LOG = os.path.join(os.path.dirname(__file__), "logs", "playlist.log")
MUSIC_DIR = os.path.join(os.path.dirname(__file__), "music")
SERVICE_NAME = "Mazes Radio"


def parse_log(year=None, month=None):
    entries = []
    with open(PLAYLIST_LOG, encoding="utf-8", errors="replace") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            parts = line.split("|", 3)
            if len(parts) < 4:
                continue
            date_str, _mount, _listeners, raw_title = parts
            try:
                dt = datetime.strptime(date_str, "%d/%b/%Y:%H:%M:%S %z")
            except ValueError:
                continue
            if year and dt.year != year:
                continue
            if month and dt.month != month:
                continue
            # Icecast XML-encodes non-ASCII in playlist.log
            title_decoded = html.unescape(raw_title.strip())
            if " - " in title_decoded:
                dash = title_decoded.index(" - ")
                artist = title_decoded[:dash].strip()
                title = title_decoded[dash + 3:].strip()
            else:
                artist = ""
                title = title_decoded
            entries.append((dt, artist, title))
    return entries


def mp3_tags(artist, title):
    """Return album/label/ISRC from the matching MP3 file, if found."""
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
            ["ffprobe", "-v", "quiet", "-print_format", "json",
             "-show_entries", "format_tags", path],
            capture_output=True, text=True, timeout=5
        ).stdout
        tags = json.loads(out).get("format", {}).get("tags", {})
        # normalise keys to lowercase for lookup
        t = {k.lower(): v for k, v in tags.items()}
        return {
            "album": t.get("album", ""),
            "label": t.get("label") or t.get("organization") or t.get("publisher") or "",
            "isrc":  t.get("isrc", ""),
        }
    except Exception:
        return {}


def duration_seconds(entries):
    """Map (artist, title) → total seconds played, estimated from log gaps."""
    durations = defaultdict(int)
    for i, (dt, artist, title) in enumerate(entries):
        if i + 1 < len(entries):
            gap = int((entries[i + 1][0] - dt).total_seconds())
            # Cap at 15 min to avoid crediting a long silence gap to one track
            durations[(artist, title)] += min(gap, 900)
    return durations


def main():
    year = month = None
    if len(sys.argv) >= 2:
        parts = sys.argv[1].split("-")
        year, month = int(parts[0]), int(parts[1])

    entries = parse_log(year, month)
    if not entries:
        print("No entries found.", file=sys.stderr)
        sys.exit(1)

    period = f"{year}-{month:02d}" if year else "all"
    print(f"# Mazes Radio — SoundExchange Report of Use — {period}", file=sys.stderr)
    print(f"# {len(entries)} plays", file=sys.stderr)

    counts = defaultdict(int)
    for _, artist, title in entries:
        counts[(artist, title)] += 1

    durations = duration_seconds(entries)

    writer = csv.writer(sys.stdout)
    writer.writerow([
        "Service Name",
        "Featured Artist",
        "Sound Recording Title",
        "Album Title",
        "Marketing Label",
        "ISRC",
        "Actual Total Performances",
        "Approx. Total Duration (seconds)",
    ])
    for (artist, title), count in sorted(counts.items(), key=lambda x: (-x[1], x[0][0])):
        tags = mp3_tags(artist, title)
        writer.writerow([
            SERVICE_NAME,
            artist,
            title,
            tags.get("album", ""),
            tags.get("label", ""),
            tags.get("isrc", ""),
            count,
            durations.get((artist, title), ""),
        ])


if __name__ == "__main__":
    main()
