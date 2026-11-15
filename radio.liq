# Log warnings and errors only. Level 3 (the default) logged ~2,000 lines an
# hour of routine detail ("Content type is ...", every decoder step) and a
# notice for each beets AcoustID fingerprint tag too long to recode.
settings.log.level := 2

# FFmpeg's own warnings ("stream 1, timescale not set" for cover art in .m4a,
# "Could not update timestamps for skipped samples" at MP3 encoder padding)
# are about every file and harmless; keep its errors.
settings.ffmpeg.log.verbosity := "error"

# The output clocks fall behind now and then, and Liquidsoap catches them up:
# up to ~0.6 s at a track change (closing one file, opening the next, the
# crossfade starting), ~1 s a couple of times a day with every show at once
# (a pause of the whole process), ~3 s when a deploy changes the music folders
# (every playlist re-read). Listeners don't hear it: each player gets ~10 s of
# audio on connecting (Icecast's burst-size, icecast/config.sh) to ride it
# out. So warn ("Latency is too high: we must catchup") only past 5 s, half of
# that (the default, 0.2 s, warned at every track change).
settings.clock.log_delay_threshold := 5.

# Autocue measures each track ahead of play (default: at up to 70x real time)
# and skips a track whose measuring it estimates at over 10 s (default), i.e.
# any over ~12 min: those then played without loudness normalization or
# silence trimming. scripts/import.sh removes tracks over 15 min, so measure
# at up to 30x, which spreads out its CPU use, and allow 40 s: tracks up to
# 20 min. A track is measured while the one before it plays.
settings.autocue.internal.ratio := 30.
settings.autocue.internal.timeout := 40.
enable_autocue_metadata()

# Preparing a track (measuring included) may take as long as autocue allows.
# The measuring isn't cut off at this limit (default 29 s), but Liquidsoap
# warns "Time limit exceeded" for a track that takes longer.
settings.request.timeout := 45.

# One 24/7 MP3 stream, Icecast mount /stream (public at /stream via Caddy),
# playing the shows on a daily schedule. Every shows/<slug>.md is a show,
# playing music/<slug>/ on shuffle during its `hours:` (front matter, see
# show_hours); each play is appended to /plays/YYYY-MM.jsonl (read by the app's
# pages and report). Hours edits apply within a minute; adding or removing a
# show needs a Liquidsoap restart (no listener is dropped), which
# scripts/reconcile.sh does when needed.

# A show's hours, from `hours: <start>-<end>` in its front matter: whole hours
# on a 24-hour clock in local time (TZ), the end not included; 22-6 runs past
# midnight, 0-24 all day. (0, 0), never on air, when there are none (or no file).
# app/shows.ts reads them the same way.
def show_hours(f) =
  try
    lines = string.split(separator="\n", file.contents(f))
    def rec front(acc, ls) =
      if
        ls == [] or string.trim(list.hd(ls)) == "---"
      then
        acc
      else
        front("#{acc}#{list.hd(ls)}\n", list.tl(ls))
      end
    end
    yml = if lines != [] and string.trim(list.hd(lines)) == "---" then front("", list.tl(lines)) else "" end
    let yaml.parse (meta : {hours?: string}) = yml
    m = r/^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(meta.hours ?? "")
    start = int_of_string(list.assoc(1, m))
    stop = int_of_string(list.assoc(2, m))
    if start < 24 and stop <= 24 then (start, stop) else (0, 0) end
  catch _ do
    (0, 0)
  end
end

# Whether hour (0-23) is within hours (show_hours).
def within(hour, hours) =
  let (start, stop) = hours
  if
    start < stop
  then
    hour >= start and hour < stop
  elsif
    start > stop
  then
    hour >= start or hour < stop
  else
    false
  end
end

# The show put on air by hand, overriding the schedule ("" for none). Only the
# end-to-end tests do (test/compose.yml sets ONAIR_PORT): POST /onair with a
# slug, or nothing to go back to the schedule, on that port, which only the
# containers' own network reaches.
onair = ref("")
onair_port = int_of_string(default=0, environment.get("ONAIR_PORT"))
if
  onair_port > 0
then
  harbor.http.register.simple(
    port=onair_port,
    method="POST",
    "/onair",
    fun (req) ->
      begin
        onair := string.trim(req.body())
        log.important(
          "On air by hand: #{onair()}"
        )
        http.response(content_type="text/plain", data="#{onair()}\n")
      end
  )
end

# Artists of a track (split on ",", "&", "feat.", "x", "with").
def artists_of(a) =
  parts =
    string.split(
      separator=",|&| feat\\.? | ft\\.? | x | with ",
      string.case(lower=true, a)
    )
  list.filter(fun (x) -> x != "", list.map(string.trim, parts))
end

# A track's artists, from its tag.
def track_artists(r) =
  artists_of(list.assoc(default="", "artist", request.metadata(r)))
end

# Listeners on an Icecast mount right now, from its status page; 0 on error.
def listeners(mount) =
  try
    let json.parse (status : {icestats: {source: {listeners: int}}}) =
      http.get(timeout=2., "http://icecast:8000/status-json.xsl?mount=/#{mount}")
    status.icestats.source.listeners
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

# A show's source.
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

  tracks = playlist(mode="randomize", reload_mode="watch", check_next=artist_not_recent, "/music/#{slug}")

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
            listeners = listeners("stream")
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
  music = blank.skip(max_blank=10., amplify(1., tracks))

  music
end

shows = file.ls(absolute=true, pattern="*.md", "/shows")
slug_of = fun (f) -> path.remove_extension(path.basename(f))

# Each show's hours, by slug, re-read every minute so an edit applies without
# a restart.
read_hours = fun () -> list.map(fun (f) -> (slug_of(f), show_hours(f)), shows)
schedule = ref(read_hours())

# Every hour must have exactly one show. app/check-schedule.ts stops a commit
# or deploy that breaks this; if it happens anyway, it's an error in the log,
# but the stream goes on: an hour without a show plays silence, and one with
# two plays the first by slug.
def check_schedule() =
  list.iter(
    fun (s) ->
      begin
        log.important(
          "#{fst(s)}: hours #{snd(s)}"
        )
        if
          snd(s) == (0, 0)
        then
          log.severe(
            "#{fst(s)}: no valid hours (e.g. hours: 6-17)"
          )
        end
      end,
    schedule()
  )
  list.iter(
    fun (hour) ->
      begin
        on = list.map(fst, list.filter(fun (s) -> within(hour, snd(s)), schedule()))
        if
          on == []
        then
          log.severe(
            "#{hour}:00: no show on air (silence)"
          )
        elsif
          list.length(on) > 1
        then
          log.severe(
            "#{hour}:00: more than one show on air: #{on}"
          )
        end
      end,
    list.init(24, fun (h) -> h)
  )
end
check_schedule()
thread.run(
  every=60.,
  fun () ->
    begin
      now = read_hours()
      if
        now != schedule()
      then
        schedule := now
        check_schedule()
      end
    end
)

# Whether a show is on air: by its hours, or by hand (onair).
def on_air(slug) =
  fun () ->
    if
      onair() != ""
    then
      onair() == slug
    else
      within(time.local().hour, list.assoc(default=(0, 0), slug, schedule()))
    end
end

# The show on air: when one's hours start, the playing track finishes first
# (track_sensitive), so a show starts up to a track late. A show off air isn't
# played at all: it picks up where it left off (and logs nothing meanwhile).
# Hours no show has, or a show with nothing to play (no music, or every file
# fails), play silence (mksafe), so listeners stay connected.
music = switch(track_sensitive=true, list.map(fun (f) -> (on_air(slug_of(f)), show(f)), shows))
music = crossfade(duration=12., fade_in=6., fade_out=6., music)

# Limiter catches peaks from tracks autocue boosted and crossfade overlaps.
radio = limit(mksafe(music))
radio = metadata.map(fun (m) -> list.map(fun (kv) -> (fst(kv), safe_recode(snd(kv))), m), radio)

# icecast/silence.mp3 (Icecast's fallback while this restarts; see
# icecast/config.sh) is the same format: change both together.
output.icecast(
  %mp3(bitrate = 256),
  encoding="UTF-8",
  # Only "song" ("Artist - Title"), which Icecast shows players as the
  # StreamTitle. Sending artist and title too made Icecast warn on every
  # track that it got "song" but also "artist" and/or "title".
  icy_metadata=["song"],
  host="icecast",
  password=environment.get("PASSWORD"),
  mount="stream",
  radio
)

# The shows this process plays, for scripts/reconcile.sh to compare with /shows.
file.write(data=string.concat(separator="\n", shows), "/tmp/shows")
