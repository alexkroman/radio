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

# The sound recording performance complement (17 U.S.C. 114(j)(13)), a
# condition of the statutory license, across the station (one channel): in
# any three hours, at most 4 tracks by one featured artist (3 in a row) and 3
# from one album (2 in a row). A candidate that would break it is never
# picked: if a show has nothing else, it plays silence until it can. Checked
# on what has played (on_track) plus what's picked and not yet played: this
# show's next tracks play before the candidate, and another show's (picked
# while it was on) may play right after it, so those count towards a run too.
# COMPLEMENT_WINDOW (seconds) is for the end-to-end tests only.
complement_window = float_of_string(default=10800., environment.get("COMPLEMENT_WINDOW"))

# A track for the complement: its featured artists, and its album (by title,
# lowercased, "" for none: two albums with one title count as one, which is
# stricter than the law; app/complement.ts checks the play log the same way).
def complement_entry(uri, m) =
  {
    file = uri,
    artists = artists_of(list.assoc(default="", "artist", m)),
    album = string.case(lower=true, string.trim(list.assoc(default="", "album", m)))
  }
end

# Played tracks, newest first ({time, artists, album}), and picked ones not
# yet played, oldest first ({show, file, artists, album}).
complement_played = ref([])
complement_pending = ref([])

# Whether a candidate track (request metadata) for show slug keeps the complement.
def complement_allows(slug, uri, m) =
  c = complement_entry(uri, m)
  now = time()
  played = list.filter(fun (p) -> p.time > now - complement_window, complement_played())
  own = list.filter(fun (p) -> p.show == slug, complement_pending())
  others = list.filter(fun (p) -> p.show != slug, complement_pending())

  # Everything that counts in the window, and the tracks in the order they
  # play before the candidate, newest first.
  everything =
    list.append(
      list.map(fun (p) -> (p.artists, p.album), played),
      list.map(fun (p) -> (p.artists, p.album), complement_pending())
    )
  before =
    list.append(
      list.rev(list.map(fun (p) -> (p.artists, p.album), own)),
      list.map(fun (p) -> (p.artists, p.album), played)
    )
  def rec run(matches, ls) =
    if ls != [] and matches(list.hd(ls)) then 1 + run(matches, list.tl(ls)) else 0 end
  end
  def count(matches, ls) =
    list.length(list.filter(matches, ls))
  end
  def by_artist(a) =
    fun (e) -> list.mem(a, fst(e))
  end
  def from_album(e) =
    snd(e) == c.album
  end
  others_entries = list.map(fun (p) -> (p.artists, p.album), others)
  artists_ok =
    list.for_all(
      fun (a) ->
        count(by_artist(a), everything) < 4
        and run(by_artist(a), before) + 1 + count(by_artist(a), others_entries) <= 3,
      c.artists
    )
  album_ok =
    c.album == ""
    or (
      count(from_album, everything) < 3
      and run(from_album, before) + 1 + count(from_album, others_entries) <= 2
    )
  artists_ok and album_ok
end

# A track starts playing: it's played, no longer pending.
def complement_played_now(m) =
  c = complement_entry(list.assoc(default="", "filename", m), m)
  now = time()
  complement_pending := list.filter(fun (p) -> p.file != c.file, complement_pending())
  complement_played :=
    {time = now, artists = c.artists, album = c.album}::list.filter(
      fun (p) -> p.time > now - complement_window,
      complement_played()
    )
end

# The archive: the program as broadcast (`radio`, the final bus, so anything
# mixed into it is recorded too), one MP3 per show block, the same 256 kbps
# as the stream. A block is its show's hours by the clock plus ARCHIVE_TAIL
# seconds (default 60) of what follows, so a 17-22 block is a little over
# five hours, and a short gap (a restart) doesn't take it under. The file is
# /archive/recording/<show>-<YYYY-MM-DD>.mp3 (the date the block started)
# while it's recorded; when it ends it moves to /archive/blocks/, which
# Icecast serves and the app lists (/archive), if it's at least
# ARCHIVE_MIN_SECONDS long (default 5 hours: an archived program under the
# statutory license must be), else to /archive/short/, which nothing serves
# and scripts/prune-archive.sh empties. A restart mid-block appends to the
# same file. A recording is its own output: an error writing it (a full
# disk) retries every 10 s and never touches the stream.
#
# Each block has a sidecar, /archive/tracks/<show>-<YYYY-MM-DD>.jsonl: one
# line per track, with its offset in the file in seconds, so a player can
# show each track's title, album and artist while it plays (the license
# requires that), and the reports can count archive plays per track. The
# sidecars are kept after their blocks (for the reports).
archive_recording = "/archive/recording"
archive_blocks = "/archive/blocks"
archive_short = "/archive/short"
archive_tracks = "/archive/tracks"
archive_bytes_per_second = 32000.
archive_tail = float_of_string(default=60., environment.get("ARCHIVE_TAIL"))
archive_min = float_of_string(default=18000., environment.get("ARCHIVE_MIN_SECONDS"))

# The track playing now, for a block that opens mid-track.
no_track = {title = "", artist = "", album = "", label = "", isrc = "", cover = ""}
current_track = ref(no_track)

# A sidecar line: a track at an offset (seconds) in a block's file.
def sidecar_line(offset, t) =
  line =
    {
      offset = offset,
      title = t.title,
      artist = t.artist,
      album = t.album,
      label = t.label,
      isrc = t.isrc,
      cover = t.cover
    }
  "#{json.stringify(compact=true, line)}\n"
end

# A track starts: add it to the sidecar of every block being recorded (one,
# or two in a block's tail), at the file's length so far.
def archive_track(play) =
  t =
    {
      title = play.title,
      artist = play.artist,
      album = play.album,
      label = play.label,
      isrc = play.isrc,
      cover = play.cover
    }
  current_track := t
  list.iter(
    fun (f) ->
      try
        offset = float_of_int(file.size(f)) / archive_bytes_per_second
        file.write(
          append=true,
          data=sidecar_line(offset, t),
          "#{archive_tracks}/#{path.remove_extension(path.basename(f))}.jsonl"
        )
      catch e do
        log.severe(
          "Archive: couldn't add a track to #{f}'s sidecar: #{e}"
        )
      end,
    file.ls(absolute=true, pattern="*.mp3", archive_recording)
  )
end

# A show's source.
def show(f) =
  slug = path.remove_extension(path.basename(f))

  # Artist separation, beyond the complement: reject a candidate if any of
  # its artists was among the last 20 artists picked on this show; after 20
  # rejections in a row (a show with few artists) take it anyway (the
  # complement still holds). A track's artists are recorded when it's picked,
  # so the next pick (which can come before the track starts, or before its
  # async on_track below is done) already sees them.
  recent_artists = ref([])
  rejected = ref(0)
  def next_ok(r) =
    # A candidate isn't resolved yet, so its tags are read from the file
    # (quickly: without autocue's measuring).
    uri = request.uri(r)
    m =
      try
        file.metadata(exclude=["autocue"], uri)
      catch _ do
        []
      end
    artists = artists_of(list.assoc(default="", "artist", m))
    name = path.basename(uri)
    if
      not complement_allows(slug, uri, m)
    then
      log.info(
        label=slug,
        "Skipping #{name}: the performance complement"
      )
      false
    elsif
      rejected() < 20 and list.exists(fun (a) -> list.mem(a, recent_artists()), artists)
    then
      rejected := rejected() + 1
      log.info(
        label=slug,
        "Skipping #{name}: artist played recently"
      )
      false
    else
      rejected := 0
      recent_artists := list.prefix(20, list.append(artists, recent_artists()))
      c = complement_entry(uri, m)
      complement_pending :=
        list.append(
          complement_pending(),
          [{show = slug, file = c.file, artists = c.artists, album = c.album}]
        )
      true
    end
  end

  tracks = playlist(mode="randomize", reload_mode="watch", check_next=next_ok, "/music/#{slug}")
  tracks.on_track(synchronous=true, complement_played_now)

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
        archive_track(play)
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

# The in-stream title players show: "Artist - Title (Album)". The license
# requires identifying each track's title, album and featured artist while it
# plays, in a way players can display.
def icy_song(m) =
  artist = list.assoc(default="", "artist", m)
  title = list.assoc(default="", "title", m)
  album = list.assoc(default="", "album", m)
  if
    title == ""
  then
    []
  else
    song =
      artist == ""
        ? title
        : "#{artist} - #{title}"
    [
      (
        "song",
        album == ""
          ? song
          : "#{song} (#{album})"
      )
    ]
  end
end
radio = metadata.map(update=true, icy_song, radio)

# Encoders get only the metadata keys listed here: add "song", or Icecast
# would build its own "Artist - Title".
settings.encoder.metadata.export := list.append(settings.encoder.metadata.export(), ["song"])

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

# "YYYY-MM-DD" for a local date.
def ymd(t) =
  pad = fun (n) -> n < 10 ? "0#{n}" : "#{n}"
  "#{t.year}-#{pad(t.month)}-#{pad(t.day)}"
end

# A show's hours (show_hours) now.
def hours_of(slug) =
  list.assoc(default=(0, 0), slug, schedule())
end

# Whether a show's block is being recorded: in its hours, or in the tail.
def recording_on(slug) =
  fun () ->
    begin
      hours = hours_of(slug)
      let (_, stop) = hours
      now = time.local()
      within(now.hour, hours)
      or (hours != (0, 0) and now.hour == stop mod 24 and float_of_int(now.min * 60 + now.sec) < archive_tail)
    end
end

# The block a show is recording: "<show>-<YYYY-MM-DD>", the date it started
# (yesterday for 22-6 at 2:00, or in its tail at 6:00).
def block_name(slug) =
  let (start, _) = hours_of(slug)
  now = time.local()
  day =
    if
      now.hour >= start
    then
      now
    else
      # Two hours before today's midnight, DST or not.
      time.local(time() - float_of_int(now.hour * 3600 + now.min * 60 + now.sec + 7200))
    end
  "#{slug}-#{ymd(day)}"
end

# A block ended: to blocks/ if long enough, else short/.
def finish_block(f) =
  name = path.basename(f)
  seconds = float_of_int(file.size(f)) / archive_bytes_per_second
  dest = seconds >= archive_min ? archive_blocks : archive_short
  if
    dest == archive_short
  then
    log.severe(
      "Archive: #{name} is only #{seconds} s (under #{archive_min} s): not archived"
    )
  else
    log.important(
      "Archive: #{name} finished (#{seconds} s)"
    )
  end
  try
    file.move(force=true, f, "#{dest}/#{name}")
  catch e do
    log.severe(
      "Archive: couldn't move #{f} to #{dest}: #{e}"
    )
  end
end

# The show a recording is for.
def slug_of_block(f) =
  m = r/^(.+)-\d{4}-\d{2}-\d{2}\.mp3$/.exec(path.basename(f))
  list.assoc(default="", 1, m)
end

# Blocks that ended while this wasn't running.
def finish_if_ended(f) =
  on = recording_on(slug_of_block(f))
  if not on() then finish_block(f) end
end
list.iter(finish_if_ended, file.ls(absolute=true, pattern="*.mp3", archive_recording))

# Each show's recorder: on while its block is, so a new file each block.
def recorder(f) =
  slug = slug_of(f)
  on = recording_on(slug)
  output.file(
    id="archive-#{slug}",
    fallible=true,
    %mp3(bitrate = 256),
    # The same block after a restart: carry on in its file.
    append=true,
    # Each file closes when its block ends, or when this stops (a restart):
    # only an ended block is finished.
    on_close=fun (f) -> if not on() then finish_block(f) end,
    reopen_on_error=fun (e) ->
      begin
        log.severe(
          "Archive: recording #{slug} failed, retrying in 10 s: #{e}"
        )
        10.
      end,
    {
      begin
        name = block_name(slug)
        target = "#{archive_recording}/#{name}.mp3"

        # A block that ended and starts again (its hours changed back) carries on.
        list.iter(
          fun (d) ->
            if
              not file.exists(target) and file.exists("#{d}/#{name}.mp3")
            then
              file.move("#{d}/#{name}.mp3", target)
            end,
          [archive_blocks, archive_short]
        )

        # A new block starts with the track playing.
        if
          not file.exists(target)
        then
          file.write(
            data=current_track().title == "" ? "" : sidecar_line(0., current_track()),
            "#{archive_tracks}/#{name}.jsonl"
          )
        end
        target
      end
    },
    # No track titles in the file: they're in the sidecar.
    switch(track_sensitive=false, [(on, source.drop.metadata(radio))])
  )
end
list.iter(recorder, shows)

# The shows this process plays, for scripts/reconcile.sh to compare with /shows.
file.write(data=string.concat(separator="\n", shows), "/tmp/shows")
