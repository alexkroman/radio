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

# Played tracks, newest first ({time, artists, album}): written only by the
# shows' on_track, which all run on the one clock's thread.
complement_played = ref([])

# Picked tracks not yet played, oldest first ({show, seq, file, artists,
# album}). Each show keeps its own (show() below): its picks are written only
# by its playlist's check_next, which runs on another thread than on_track, so
# no list here is written from two threads (Liquidsoap has no mutex: a
# read-then-write from each could drop the other's change). A getter per
# show, registered as the shows are built at startup.
complement_shows = ref([])
def complement_pending() =
  list.flatten(list.map(fun (pending) -> pending(), complement_shows()))
end

# Whether a candidate track (request metadata) for show slug keeps the complement.
# What the complement counts of a track: its artists and album.
def complement_key(p) =
  (p.artists, p.album)
end

def complement_allows(slug, uri, m) =
  c = complement_entry(uri, m)
  now = time()
  played = list.filter(fun (p) -> p.time > now - complement_window, complement_played())
  own = list.filter(fun (p) -> p.show == slug, complement_pending())
  others = list.filter(fun (p) -> p.show != slug, complement_pending())

  # Everything that counts in the window, and the tracks in the order they
  # play before the candidate, newest first.
  everything = list.append(list.map(complement_key, played), list.map(complement_key, complement_pending()))
  before = list.append(list.rev(list.map(complement_key, own)), list.map(complement_key, played))
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
  others_entries = list.map(complement_key, others)
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

# A track starts playing: it's played (the list of picks is its show's, in
# show() below).
def complement_played_now(m, now) =
  c = complement_entry(list.assoc(default="", "filename", m), m)
  complement_played :=
    {time = now, artists = c.artists, album = c.album}::list.filter(
      fun (p) -> p.time > now - complement_window,
      complement_played()
    )
end

# The archive: the program as broadcast (`radio`, the final bus, so anything
# mixed into it is recorded too), one MP3 per show block, the same 256 kbps
# as the stream. A block follows the songs, not the clock: it starts with
# its show's first track, as the crossfade into it starts (the song before it
# fading out), and ends ARCHIVE_TAIL seconds (default 12, the crossfade's
# length) after the next show's first track starts, as its own last track
# finishes fading out. So a 17-23 show's block runs from its first track,
# a little after 17:00 (the 16:00 show's last track plays to its end first),
# to the end of its last track, a little after 23:00. A block
# under five hours isn't archived, so give shows more than that (every
# show has six) for restarts and outages to fit in. The file is
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
# A file's name without its folder and extension: a show's slug from its
# shows/<slug>.md, a block's name from its archive file.
def slug_of(f) =
  path.remove_extension(path.basename(f))
end

archive_recording = "/archive/recording"
archive_blocks = "/archive/blocks"
archive_short = "/archive/short"
archive_tracks = "/archive/tracks"
archive_bytes_per_second = 32000.
archive_tail = float_of_string(default=12., environment.get("ARCHIVE_TAIL"))
archive_min = float_of_string(default=18000., environment.get("ARCHIVE_MIN_SECONDS"))

# The longest a show's last track can run past its hours (seconds; tracks
# are at most 20 min, see autocue above). A show still "on air" after that
# isn't playing (the next show has nothing to play, so it's silence): its
# block ends, and the show whose hours it is records the silence instead.
archive_overrun = float_of_string(default=1200., environment.get("ARCHIVE_OVERRUN"))

# The show on air by its tracks, and when its latest track started ("" when
# none has played since startup), and the show before it, and when it went
# off (its block's tail). Tracks played by hand (onair) don't count.
airing = ref(("", 0.))
handover = ref(("", 0.))

# A block's sidecar.
def sidecar_path(name) =
  "#{archive_tracks}/#{name}.jsonl"
end

# The show a recording is for.
def slug_of_block(f) =
  m = r/^(.+)-\d{4}-\d{2}-\d{2}\.mp3$/.exec(path.basename(f))
  list.assoc(default="", 1, m)
end

# The track playing now, for a block that opens mid-track (its first track).
no_track = {title = "", artist = "", album = "", label = "", isrc = "", cover = ""}
current_track = ref(no_track)

# A sidecar line: a track at an offset (seconds) in a block's file.
def sidecar_line(offset, t) =
  line = t.{offset = offset}
  "#{json.stringify(compact=true, line)}\n"
end

# A track's title, artist, album, label, ISRC and cover (pre-extracted by
# scripts/import.sh), from its raw metadata (before the text recode below).
def track_info(slug, m) =
  def tag(~or_tag="", key) =
    safe_recode(list.assoc(default=list.assoc(default="", or_tag, m), key, m))
  end
  track_stem = path.remove_extension(path.basename(list.assoc(default="", "filename", m)))
  cover = "#{slug}/#{track_stem}.jpg"
  {
    title = tag("title"),
    artist = tag("artist"),
    album = tag("album"),
    label = tag(or_tag="publisher", "label"),
    isrc = tag(or_tag="tsrc", "isrc"),
    cover =
      # An archived track's, given (block_stream), else the file's if there is one.
      list.assoc(default=file.exists("/covers/#{cover}") ? cover : "", "archive_cover", m)
  }
end

# A show's track starts (as the crossfade into it starts): when it's another
# show's than the last, that show's block ends (after its tail) and this
# one's starts. Add the track, at the file's length so far, to the sidecar of
# every block being recorded but one in its tail (whose last track is still
# fading out). Synchronous, so a block that opens now starts with this track.
def archive_track(slug, m, now) =
  t = track_info(slug, m)
  current_track := t
  if
    onair() == ""
  then
    let (was, _) = airing()
    if was != slug then handover := (was, now) end
    airing := (slug, now)
  end
  let (ending, ended_at) = handover()
  list.iter(
    fun (f) ->
      if
        slug_of_block(f) == slug or not (slug_of_block(f) == ending and now - ended_at < archive_tail)
      then
        try
          offset = float_of_int(file.size(f)) / archive_bytes_per_second
          file.write(append=true, data=sidecar_line(offset, t), sidecar_path(slug_of(f)))
        catch e do
          log.severe(
            "Archive: couldn't add a track to #{f}'s sidecar: #{e}"
          )
        end
      end,
    file.ls(absolute=true, pattern="*.mp3", archive_recording)
  )
end

# A file's tags, read once per path (quickly: without autocue's measuring).
# A show the complement holds back retries its candidates until it can play
# one, so they mustn't each touch the disk.
tag_cache = ref([])
def file_tags(uri) =
  cached = list.assoc(default=[("", "")], uri, tag_cache())
  if
    cached != [("", "")]
  then
    cached
  else
    m =
      try
        file.metadata(exclude=["autocue"], uri)
      catch _ do
        []
      end
    tag_cache := (uri, m)::tag_cache()
    m
  end
end

# A stream's play log (/plays/YYYY-MM<suffix>.jsonl): f(start, show, t)
# appends a play of track t (starting at `start`) with the stream's listeners
# now, and before it, for the stream's play before it (just ended), an end
# line with the same count, {time, listeners_at_end}. A play's performances
# are the more of the two (app/plays.ts), so a listener who tunes in
# mid-track counts for that track. Each line goes in its own play's month.
def play_log(mount, suffix) =
  last = ref(-1.)
  def file_for(start) =
    t = time.local(start)
    pad = fun (n) -> n < 10 ? "0#{n}" : "#{n}"
    "/plays/#{t.year}-#{pad(t.month)}#{suffix}.jsonl"
  end
  def write(start, line) =
    file.write(append=true, data="#{json.stringify(compact=true, line)}\n", file_for(start))
  end
  fun (start, show, t) ->
    begin
      # Which play this one ends, claimed before the listener count's HTTP
      # call, so two tracks starting close together each end their own.
      ended = last()
      last := start
      n = listeners(mount)
      if ended >= 0. then write(ended, {time = ended, listeners_at_end = n}) end
      write(start, t.{time = start, show = show, listeners = n})
    end
end

# The station's play log, which every show's tracks go to while on air.
station_log = play_log("stream", "")

# A show's source.
def show(f) =
  slug = slug_of(f)

  # Artist separation, beyond the complement: reject a candidate if any of
  # its artists was among the last 20 artists picked on this show; after 20
  # rejections in a row (a show with few artists) take it anyway (the
  # complement still holds). A track's artists are recorded when it's picked,
  # so the next pick (which can come before the track starts, or before its
  # async on_track below is done) already sees them.
  recent_artists = ref([])
  rejected = ref(0)

  # This show's picks for the complement, oldest first, numbered (seq) as
  # they're picked: written only by next_ok. `started` is the number of the
  # newest pick that has started playing, written only by on_track: the picks
  # after it are pending. A track that starts uses up one pick, the oldest
  # with its file (the same file can be picked twice before it plays), and the
  # picks before that one, which the playlist dropped and won't play.
  picks = ref([])
  picked = ref(0)
  started = ref(0)
  def pending() =
    list.filter(fun (p) -> p.seq > started(), picks())
  end
  complement_shows :=
    list.append(
      complement_shows(),
      [fun () -> list.map(fun (p) -> {show = p.show, artists = p.artists, album = p.album}, pending())]
    )
  def started_now(m) =
    filename = list.assoc(default="", "filename", m)
    match = list.filter(fun (p) -> p.file == filename, pending())
    if match != [] then started := list.hd(match).seq end
  end
  def next_ok(r) =
    # A candidate isn't resolved yet, so its tags are read from the file
    # (quickly: without autocue's measuring).
    uri = request.uri(r)
    m = file_tags(uri)
    artists = artists_of(list.assoc(default="", "artist", m))
    name = path.basename(uri)
    if
      not complement_allows(slug, uri, m)
    then
      log.info(
        label=slug,
        "Skipping #{name}: the performance complement"
      )

      # The playlist tries its next candidate at once, and when the
      # complement holds every one back it would spin through them, thousands
      # a second, starving the stream's clock (it falls behind, and the
      # archive records slower than real time). A pause per refusal keeps that
      # to a few a second. It runs on the playlist's own thread, not the
      # clock's, and the next track is picked while this one plays, so it
      # costs no audio.
      thread.pause(0.1)
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
      picked := picked() + 1
      picks :=
        list.append(
          pending(),
          [{show = slug, seq = picked(), file = c.file, artists = c.artists, album = c.album}]
        )
      true
    end
  end

  tracks = playlist(mode="randomize", reload_mode="watch", check_next=next_ok, "/music/#{slug}")

  # When each track started, stamped as it starts: the complement counts by
  # these, and the play log below (written asynchronously, after an HTTP
  # call) uses the same times, so a check of the log agrees with what was
  # enforced.
  starts = ref([])
  tracks.on_track(
    synchronous=true,
    fun (m) ->
      begin
        now = time()
        started_now(m)
        complement_played_now(m, now)
        starts := list.prefix(10, (list.assoc(default="", "filename", m), now)::starts())
        archive_track(slug, m, now)
      end
  )

  # Per track (on the playlist: the crossfaded source doesn't mark every
  # track): the play log. Asynchronous, so the listener count's HTTP call
  # never holds up the stream.
  tracks.on_track(
    synchronous=false,
    fun (m) ->
      station_log(
        list.assoc(default=time(), list.assoc(default="", "filename", m), starts()),
        slug,
        track_info(slug, m)
      )
  )

  # Loudness: autocue measures each track and sets liq_amplify (gain to reach
  # -14 LUFS); amplify applies it via its default override="liq_amplify".
  # Dead air: autocue trims silence at a track's ends; blank.skip skips a track
  # (a hidden track after minutes of silence, a file that decodes to nothing)
  # once it has been silent for 10 s.
  music = blank.skip(max_blank=10., amplify(1., tracks))

  music
end

shows = file.ls(absolute=true, sorted=true, pattern="*.md", "/shows")

# Each show's hours, by slug, re-read every minute so an edit applies without
# a restart. Not while the show files differ from the ones it started with: a
# show added or removed needs a restart (scripts/reconcile.sh), and until then
# the new hours could give an hour to a show it isn't running, or take one
# from a show that went, and play silence (a deploy that stopped after syncing
# shows/ did: 85 minutes of it). Keep the hours it has until the restart.
read_hours = fun () -> list.map(fun (f) -> (slug_of(f), show_hours(f)), shows)
schedule = ref(read_hours())
shows_differ = ref(false)

# A show's hours (show_hours) now.
def hours_of(slug) =
  list.assoc(default=(0, 0), slug, schedule())
end

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
      if
        file.ls(absolute=true, sorted=true, pattern="*.md", "/shows") != shows
      then
        if
          not shows_differ()
        then
          shows_differ := true
          log.severe(
            "The shows on disk differ from the ones running: keeping their hours until a restart \
             (scripts/reconcile.sh)"
          )
        end
      else
        shows_differ := false
        now = read_hours()
        if
          now != schedule()
        then
          schedule := now
          check_schedule()
        end
      end
    end
)

# Whether a show is on air: by its hours, or by hand (onair).
def on_air(slug) =
  fun () -> if onair() != "" then onair() == slug else within(time.local().hour, hours_of(slug)) end
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

# Sets the title (ICY StreamTitle) Icecast gives players of mount `mount`.
# By POST: output.icecast's own update is a GET, which Icecast 2.5 warns about
# on every track ("uses safe method GET on /admin/metadata"). Only "song"
# ("Artist - Title (Album)"): sending artist and title too made Icecast warn
# that it got "song" but also "artist" and/or "title".
icecast_auth =
  "Basic " ^
    string.base64.encode("source:#{environment.get('PASSWORD')}")
def set_title(mount, song) =
  try
    r =
      http.post(
        timeout=5.,
        headers=[("Authorization", icecast_auth), ("Content-Type", "application/x-www-form-urlencoded")],
        data="mode=updinfo&charset=UTF-8&mount=#{url.encode('/' ^ mount)}&song=#{url.encode(song)}",
        "http://icecast:8000/admin/metadata"
      )
    if
      r.status_code != 200
    then
      log.severe(
        "Icecast /#{mount}: title update failed (#{r.status_code}): #{r}"
      )
    end
  catch e do
    log.severe(
      "Icecast /#{mount}: title update failed: #{e}"
    )
  end
end

# A stream to Icecast mount `mount`. icecast/silence.mp3 (Icecast's fallback
# while this restarts; see icecast/config.sh) is the same format: change
# both together.
def to_icecast((mount:string), s) =
  # The title playing, for a reconnect (or a first connect after it started).
  song = ref("")
  s.on_metadata(
    synchronous=false,
    fun (m) ->
      begin
        title = list.assoc(default="", "song", m)
        if
          title != ""
        then
          song := title
          set_title(mount, title)
        end
      end
  )
  o =
    output.icecast(
      id=mount,
      %mp3(bitrate = 256),
      encoding="UTF-8",
      send_icy_metadata=false,
      host="icecast",
      password=environment.get("PASSWORD"),
      mount=mount,
      s
    )
  o.on_connect(
    synchronous=false,
    fun () -> thread.run(delay=1., fun () -> if song() != "" then set_title(mount, song()) end)
  )
end
to_icecast("stream", radio)

# "YYYY-MM-DD" for a local date.
def ymd(t) =
  pad = fun (n) -> n < 10 ? "0#{n}" : "#{n}"
  "#{t.year}-#{pad(t.month)}-#{pad(t.day)}"
end

# Whether a show's block is being recorded. While a show is on air by its
# tracks (airing: within its hours, or its last track running over them),
# that show's, from its first track (its fade in) until ARCHIVE_TAIL s after
# the next show's first track (its last track's fade out). Otherwise (after
# a restart until a track starts, or silence), the show whose hours it is.
def recording_on(slug) =
  fun () ->
    begin
      let (on, started) = airing()
      hour = time.local().hour
      if
        on != "" and (within(hour, hours_of(on)) or time() - started < archive_overrun)
      then
        let (ending, ended_at) = handover()
        on == slug or (ending == slug and time() - ended_at < archive_tail)
      else
        within(hour, hours_of(slug))
      end
    end
end

# The block a show is recording: "<show>-<YYYY-MM-DD>", the date it started
# (yesterday for 22-6 at 2:00, or for its last track running over at 6:00).
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

# Whether a recording's block is over: its show isn't recording, or is
# recording another block (another day's, for a show on all day, or after
# being down from one block into the next).
def block_ended(f) =
  slug = slug_of_block(f)
  on = recording_on(slug)
  not on() or path.basename(f) != "#{block_name(slug)}.mp3"
end

# Blocks that ended while this wasn't running.
def finish_if_ended(f) =
  if block_ended(f) then finish_block(f) end
end
list.iter(finish_if_ended, file.ls(absolute=true, pattern="*.mp3", archive_recording))

# Each show's recorder: on while its block is, so a new file each block.
def recorder(f) =
  slug = slug_of(f)
  on = recording_on(slug)

  # The block in the file open now.
  opened = ref("")
  output.file(
    id="archive-#{slug}",
    fallible=true,
    %mp3(bitrate = 256),
    # The same block after a restart: carry on in its file.
    append=true,
    # Each file closes when its block ends (the switch below goes off, or the
    # day changes for a show on all day), or when this stops (a restart):
    # only an ended block is finished.
    reopen_when=fun () -> opened() != "" and block_name(slug) != opened(),
    reopen_delay=5.,
    on_close=fun (f) -> if block_ended(f) then finish_block(f) end,
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
        opened := name
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
            sidecar_path(name)
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

# Each show's own stream, Icecast mount /stream/<slug> (public at
# /stream/<slug> via Caddy, played from the show's page): its archived
# blocks, picked at random (not the one just played, when it has another),
# one after another, around the clock. These are the archived programs the
# statutory license allows: at least five hours each (finish_block), and
# none up two weeks (scripts/prune-archive.sh). Silence until the show has a
# block. A block plays whole, as one request, decoded straight through: an
# MP3 decoder started mid-file (a request per track, cut at its offset)
# makes its first frame silence or noise, a dropout at every track. Each
# track in the block's sidecar starts a new track in the stream at its
# offset (insert_metadata, new_track), tagged with it, so it's a track like
# the station's: in the ICY title, and in the show's stream's play log,
# /plays/YYYY-MM.<slug>.jsonl (play_log, as the station's), when it starts.
# No autocue: a block plays as recorded, with the broadcast's levels and
# crossfades.
def block_stream(f) =
  slug = slug_of(f)
  mount = "stream/#{slug}"
  log_play = play_log(mount, ".#{slug}")
  last = ref("")

  # A block's tracks, from its sidecar: each one's offset and tags.
  def sidecar(block) =
    lines =
      try
        string.split(separator="\n", file.contents(sidecar_path(slug_of(block))))
      catch _ do
        []
      end
    list.filter_map(
      fun (l) ->
        try
          let json.parse (o : {offset: float}) = l
          let json.parse (t :
            {title: string, artist: string, album: string, label: string, isrc: string, cover: string}
          ) = l
          (o.offset, t)
        catch _ do
          null
        end,
      lines
    )
  end

  # A track's tags, as track_info reads them back.
  def tags(t) =
    [
      ("title", t.title),
      ("artist", t.artist),
      ("album", t.album),
      ("label", t.label),
      ("isrc", t.isrc),
      ("archive_cover", t.cover)
    ]
  end

  def next() =
    blocks =
      list.filter(
        fun (b) -> slug_of_block(b) == slug,
        file.ls(absolute=true, sorted=true, pattern="*.mp3", archive_blocks)
      )
    others = list.filter(fun (b) -> b != last(), blocks)
    pick = others == [] ? blocks : others
    if
      pick == []
    then
      null
    else
      b = list.nth(pick, random.int(min=0, max=list.length(pick)))
      last := b
      ts = sidecar(b)

      # Tagged with its first track (at offset 0, as a block starts), and
      # marked as a block's start for the block's track changes.
      q = fun (v) -> "\"#{string.escape(encoding='ascii', v)}\""
      first =
        if
          ts == []
        then
          ""
        else
          string.concat(list.map(fun (kv) -> "#{fst(kv)}=#{q(snd(kv))},", tags(snd(list.hd(ts)))))
        end
      request.create(excluded_metadata_resolvers=["autocue"], "annotate:#{first}block=#{q(b)}:#{b}")
    end
  end
  blocks = request.dynamic(id="blocks-#{slug}", retry_delay=60., next)

  # The block playing: its tracks still to come, and when it started, by
  # the source's clock (time(): elapsed() and on_position count from the
  # last track, and an inserted track is one).
  to_come = ref([])
  started = ref(0.)
  blocks.on_track(
    synchronous=true,
    fun (m) ->
      begin
        block = list.assoc(default="", "block", m)
        if
          block != ""
        then
          # The first is the block's own tags; the rest are to come.
          ts = sidecar(block)
          to_come := if ts == [] then [] else list.tl(ts) end
          started := blocks.time()
        end
      end
  )
  blocks.on_frame(
    synchronous=true,
    fun () ->
      if
        to_come() != [] and blocks.time() - started() >= fst(list.hd(to_come()))
      then
        t = snd(list.hd(to_come()))
        to_come := list.tl(to_come())
        blocks.insert_metadata(new_track=true, tags(t))
      end
  )

  # Asynchronous, so the listener count's HTTP call never holds up the stream.
  blocks.on_track(synchronous=false, fun (m) -> log_play(time(), slug, track_info(slug, m)))
  to_icecast(mount, metadata.map(update=true, icy_song, mksafe(blocks)))
end
list.iter(block_stream, shows)

# The shows this process plays, for scripts/reconcile.sh to compare with /shows.
file.write(data=string.concat(separator="\n", shows), "/tmp/shows")
