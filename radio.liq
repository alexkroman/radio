enable_autocue_metadata()

# Every shows/<slug>.md is a 24/7 MP3 stream on Icecast mount /<slug> (public
# at /<slug>/stream via Caddy) playing music/<slug>/ on shuffle. Each play is
# appended to /plays/YYYY-MM.jsonl (read by the app's page and report).
# Adding or removing a show needs `docker compose restart liquidsoap`.

# Artists of a track (split on ",", "&", "feat.", "x", "with"); falls back to
# the "Artist- Title" filename when the file has no artist tag.
def artists_of(a) =
  parts =
    string.split(
      separator=",|&| feat\\.? | ft\\.? | x | with ",
      string.case(lower=true, a)
    )
  list.filter(fun (x) -> x != "", list.map(string.trim, parts))
end

def track_artists(r) =
  a = list.assoc(default="", "artist", request.metadata(r))
  artists_of(
    if
      a != ""
    then
      a
    else
      list.hd(
        default="",
        string.split(
          separator="- ",
          path.basename(request.uri(r))
        )
      )
    end
  )
end

# Untagged files get artist/title from an "Artist- Title" file name (or the
# whole name as title) so they still show up in the log and the report.
def title_from_filename(m) =
  if
    list.assoc(default="", "title", m) != ""
  then
    []
  else
    name = path.remove_extension(path.basename(list.assoc(default="", "filename", m)))
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
end

# Listeners on an Icecast mount right now, from its status page (whose
# "source" is an object for one mount and a list for several); 0 on error.
def listeners(mount) =
  body =
    try
      http.get(timeout=2., "http://icecast:8000/status-json.xsl")
    catch _ do
      ""
    end
  try
    let json.parse ({icestats = {source}} : {icestats: {source: [{listenurl: string, listeners: int}]}}) =
      body
    list.fold(
      fun (n, s) -> if string.contains(suffix="/#{mount}", s.listenurl) then n + s.listeners else n end,
      0,
      source
    )
  catch _ do
    try
      let json.parse ({icestats = {source}} : {icestats: {source: {listenurl: string, listeners: int}}}) =
        body
      if string.contains(suffix="/#{mount}", source.listenurl) then source.listeners else 0 end
    catch _ do
      0
    end
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
    catch e do
      s
    end
  end
end

def show(f) =
  slug = path.remove_extension(path.basename(f))
  cover_file = "/covers/#{slug}.jpg"

  # Artist separation: reject a candidate if any of its artists was among the
  # last 20 artists played on this show; after 20 rejections in a row (a show
  # with few artists) take the next track anyway rather than go silent.
  recent_artists = ref([])
  rejected = ref(0)
  def artist_not_recent(r) =
    if
      rejected() < 20 and list.exists(fun (a) -> list.mem(a, recent_artists()), track_artists(r))
    then
      rejected := rejected() + 1
      log.info(
        label=slug,
        "Skipping #{path.basename(request.uri(r))}: artist played recently"
      )
      false
    else
      rejected := 0
      true
    end
  end

  tracks =
    metadata.map(
      insert_missing=true,
      title_from_filename,
      playlist(
        mode="randomize",
        reload_mode="watch",
        check_next=fun (r) -> not string.contains(suffix=".gitkeep", request.uri(r)) and artist_not_recent(r),
        "/music/#{slug}"
      )
    )

  # Per track (on the playlist: the crossfaded source doesn't mark every track),
  # from the raw metadata before the text recode below: cover, artist
  # separation and the play log.
  tracks.on_track(
    fun (m) ->
      begin
        def tag(key, fallback) =
          safe_recode(list.assoc(default=list.assoc(default="", fallback, m), key, m))
        end
        play =
          {
            time = time(),
            show = slug,
            artist = tag("artist", ""),
            title = tag("title", ""),
            album = tag("album", ""),
            label = tag("label", "publisher"),
            isrc = tag("isrc", "tsrc"),
            listeners = listeners(slug)
          }
        file.write(
          append=true,
          data="#{json.stringify(compact=true, play)}\n",
          "/plays/#{time.string('%Y-%m')}.jsonl"
        )

        cover = metadata.cover(m)
        if
          null.defined(cover)
        then
          file.write(data=null.get(cover), cover_file)
        elsif
          file.exists(cover_file)
        then
          file.remove(cover_file)
        end
        recent_artists :=
          list.prefix(20, list.append(artists_of(list.assoc(default="", "artist", m)), recent_artists()))
      end
  )

  # Loudness: autocue measures each track and sets liq_amplify (gain to reach
  # -14 LUFS); amplify applies it via its default override="liq_amplify".
  music = crossfade(duration=12., fade_in=6., fade_out=6., amplify(1., tracks))

  # Limiter catches peaks from tracks autocue boosted and crossfade overlaps.
  radio = limit(mksafe(music))
  radio = metadata.map(fun (m) -> list.map(fun (kv) -> (fst(kv), safe_recode(snd(kv))), m), radio)
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
