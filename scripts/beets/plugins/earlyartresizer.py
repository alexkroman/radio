"""Set up beets' image resizer when beets starts.

beets creates it the first time it handles cover art: mid-import, on a worker
thread, while other threads make web requests. Creating it runs
`magick --version` (and `convert --version`) to look for ImageMagick, and on
macOS a fork at that point can crash in the child ("Python quit
unexpectedly", a SIGSEGV in nw_settings_child_has_forked). Here, at startup,
nothing else is running yet. Without ImageMagick it uses Pillow, in-process,
so nothing else forks during the import.
"""

from beets.plugins import BeetsPlugin
from beets.util.artresizer import ArtResizer


class EarlyArtResizer(BeetsPlugin):
    def __init__(self) -> None:
        super().__init__()
        ArtResizer.shared  # noqa: B018 -- creates the shared instance
