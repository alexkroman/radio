# Autocue measures each track (at up to 70x real time) and by default skips a
# track whose measuring it estimates at over 10 s, i.e. any over ~12 min: those
# then played without loudness normalization or silence trimming. Allow 60 s
# (tracks up to 70 min; none is over 15). The measuring isn't bound by
# settings.request.timeout.
settings.autocue.internal.timeout := 60.
enable_autocue_metadata()

# Every shows/<slug>.md is a 24/7 MP3 stream on Icecast mount /<slug> (public
# at /<slug>/stream via Caddy) playing music/<slug>/ on shuffle. Each play is
# appended to /plays/YYYY-MM.jsonl (read by the app's page and report).
# Adding or removing a show needs (neither drops a listener):
#   docker compose exec icecast sh /icecast/config.sh reload
#   docker compose restart liquidsoap

# Artists of a track (split on ",", "&", "feat.", "x", "with").
def artists_of(a) =
  parts =
    string.split(
      separator=",|&| feat\\.? | ft\\.? | x | with ",
      string.case(lower=true, a)
    )
  list.filter(fun (x) -> x != "", list.map(string.trim, parts))
end

# Artist and title from an "Artist- Title" file name (or the whole name as
# title), for untagged files.
def filename_tags(uri) =
  name = path.remove_extension(path.basename(uri))
  parts =
    string.split(
      separator="- ",
      name
    )
  if
    list.length(parts) > 1
  then
    [
      ("artist", list.hd(default="", parts)),
      (
        "title",
        string.concat(
          separator="- ",
          list.tl(parts)
        )
      )
    ]
  else
    [("title", name)]
  end
end

# A track's artists, from its tag or (untagged) its file name.
def track_artists(r) =
  a = list.assoc(default="", "artist", request.metadata(r))
  artists_of(if a != "" then a else list.assoc(default="", "artist", filename_tags(request.uri(r))) end)
end

# Untagged files get artist/title from their file name so they still show up
# in the log and the report.
def title_from_filename(m) =
  if
    list.assoc(default="", "title", m) != ""
  then
    []
  else
    filename_tags(list.assoc(default="", "filename", m))
  end
end

# Listeners on an Icecast mount right now, from its status page; 0 on error.
def listeners(mount) =
  try
    let json.parse ({icestats = {source}} : {icestats: {source: {listeners: int}}}) =
      http.get(timeout=2., "http://icecast:8000/status-json.xsl?mount=/#{mount}")
    source.listeners
  catch _ do
    0
  end
end

def safe_recode(s) =
  if
    string.bytes.length(s) > 1024
  then
    s
  else
    try
      string.recode(s)
    catch _ do
      s
    end
  end
end

# Played on a show that has nothing else to play (optional).
offline = "/music/offline.mp3"

def show(f) =
  slug = path.remove_extension(path.basename(f))

  # Artist separation: reject a candidate if any of its artists was among the
  # last 20 artists picked on this show; after 20 rejections in a row (a show
  # with few artists) take the next track anyway rather than go silent. A
  # track's artists are recorded when it's picked, so the next pick (which can
  # come before the track starts, or before its async on_track below is done)
  # already sees them.
  recent_artists = ref([])
  rejected = ref(0)
  def artist_not_recent(r) =
    artists = track_artists(r)
    if
      rejected() < 20 and list.exists(fun (a) -> list.mem(a, recent_artists()), artists)
    then
      rejected := rejected() + 1
      log.info(
        label=slug,
        "Skipping #{path.basename(request.uri(r))}: artist played recently"
      )
      false
    else
      rejected := 0
      recent_artists := list.prefix(20, list.append(artists, recent_artists()))
      true
    end
  end

  tracks =
    metadata.map(
      insert_missing=true,
      title_from_filename,
      playlist(mode="randomize", reload_mode="watch", check_next=artist_not_recent, "/music/#{slug}")
    )

  # Per track (on the playlist: the crossfaded source doesn't mark every track),
  # from the raw metadata before the text recode below: the play log (with the
  # track's cover, pre-extracted by scripts/import.sh).
  # Asynchronous, so the listener count's HTTP call never holds up the stream.
  tracks.on_track(
    synchronous=false,
    fun (m) ->
      begin
        def tag(~or_tag="", key) =
          safe_recode(list.assoc(default=list.assoc(default="", or_tag, m), key, m))
        end
        track_stem = path.remove_extension(path.basename(list.assoc(default="", "filename", m)))
        cover = "#{slug}/#{track_stem}.jpg"
        play =
          {
            time = time(),
            show = slug,
            artist = tag("artist"),
            title = tag("title"),
            album = tag("album"),
            label = tag(or_tag="publisher", "label"),
            isrc = tag(or_tag="tsrc", "isrc"),
            cover = if file.exists("/covers/#{cover}") then cover else "" end,
            listeners = listeners(slug)
          }
        file.write(
          append=true,
          data="#{json.stringify(compact=true, play)}\n",
          "/plays/#{time.string('%Y-%m')}.jsonl"
        )
      end
  )

  # Loudness: autocue measures each track and sets liq_amplify (gain to reach
  # -14 LUFS); amplify applies it via its default override="liq_amplify".
  # Dead air: autocue trims silence at a track's ends; blank.skip skips a track
  # (a hidden track after minutes of silence, a file that decodes to nothing)
  # once it has been silent for 10 s.
  music = crossfade(duration=12., fade_in=6., fade_out=6., blank.skip(max_blank=10., amplify(1., tracks)))

  # When the show has nothing to play (no music, or every file fails), play
  # music/offline.mp3 if there is one, else silence (mksafe), so listeners
  # stay connected either way.
  music =
    if file.exists(offline) then fallback(track_sensitive=false, [music, single(offline)]) else music end

  # Limiter catches peaks from tracks autocue boosted and crossfade overlaps.
  radio = limit(mksafe(music))
  radio = metadata.map(fun (m) -> list.map(fun (kv) -> (fst(kv), safe_recode(snd(kv))), m), radio)

  # icecast/silence.mp3 (Icecast's fallback while this restarts; see
  # icecast/config.sh) is the same format: change both together.
  output.icecast(
    %mp3(bitrate = 256),
    encoding="UTF-8",
    host="icecast",
    password=environment.get("PASSWORD"),
    mount=slug,
    radio
  )
end

list.iter(show, file.ls(absolute=true, pattern="*.md", "/shows"))
