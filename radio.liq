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

# The station: one 24/7 MP3 stream, Icecast mount /stream (public at /stream
# via Caddy), playing the shows on a daily schedule. Every shows/<slug>.md is
# a show, playing music/<slug>/ on shuffle during its `hours:` (front matter,
# see show_hours); each play is appended to /plays/YYYY-MM.jsonl (read by the
# app's pages and report). Hours edits apply within a minute; adding or
# removing a show needs a Liquidsoap restart (no listener is dropped), which
# scripts/reconcile.sh does when needed.
#
# And a channel per show: its music around the clock, mount /stream/<slug>
# (public at /stream/<slug>, linked from the show's page), with a playlist,
# performance complement and play log (/plays/YYYY-MM.<slug>.jsonl, for the
# reports) of its own. A channel doesn't count as on air.

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
# condition of the statutory license, per channel (the station, and each
# show's own): in any three hours, at most 4 tracks by one featured artist (3 in a row) and 3
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

# A channel's complement: `played`, its played tracks, newest first ({time,
# artists, album}): written only by its shows' on_track, which all run on the
# one clock's thread. `shows`, its picked tracks not yet played, oldest first
# ({show, seq, file, artists, album}). Each show keeps its own (show() below):
# its picks are written only by its playlist's check_next, which runs on
# another thread than on_track, so no list here is written from two threads
# (Liquidsoap has no mutex: a read-then-write from each could drop the other's
# change). A getter per show, registered as the shows are built at startup.
def complement_channel() =
  played = ref([])
  shows = ref([])
  {
    played = fun () -> played(),
    set_played = fun (l) -> played := l,
    shows = fun () -> shows(),
    add_show = fun (pending) -> shows := list.append(shows(), [pending])
  }
end
def complement_pending(ch) =
  list.flatten(list.map(fun (pending) -> pending(), ch.shows()))
end

# Whether a candidate track (request metadata) for show slug keeps the complement.
# What the complement counts of a track: its artists and album.
def complement_key(p) =
  (p.artists, p.album)
end

def complement_allows(ch, slug, uri, m) =
  c = complement_entry(uri, m)
  now = time()
  pending = complement_pending(ch)
  played = list.filter(fun (p) -> p.time > now - complement_window, ch.played())
  own = list.filter(fun (p) -> p.show == slug, pending)
  others = list.filter(fun (p) -> p.show != slug, pending)

  # Everything that counts in the window, and the tracks in the order they
  # play before the candidate, newest first.
  everything = list.append(list.map(complement_key, played), list.map(complement_key, pending))
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
def complement_played_now(ch, m, now) =
  c = complement_entry(list.assoc(default="", "filename", m), m)
  ch.set_played(
    {time = now, artists = c.artists, album = c.album}::list.filter(
      fun (p) -> p.time > now - complement_window,
      ch.played()
    )
  )
end

# A show's slug, from its shows/<slug>.md.
def slug_of(f) =
  path.remove_extension(path.basename(f))
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
    cover = file.exists("/covers/#{cover}") ? cover : ""
  }
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

# A show's source, on a channel (ch, its complement): the station's, which
# logs to /plays/YYYY-MM.jsonl, or the show's own
# (~channel=true), which logs to /plays/YYYY-MM.<slug>.jsonl. `mount`: the
# Icecast mount its listeners are counted on.
def show(ch, ~channel=false, ~mount, f) =
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
  ch.add_show(fun () -> list.map(fun (p) -> {show = p.show, artists = p.artists, album = p.album}, pending()))
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
      not complement_allows(ch, slug, uri, m)
    then
      log.info(
        label=slug,
        "Skipping #{name}: the performance complement"
      )

      # The playlist tries its next candidate at once, and when the
      # complement holds every one back it would spin through them, thousands
      # a second, starving the stream's clock (it falls behind, and the
      # outputs fall behind). A pause per refusal keeps that
      # to a few a second. It runs on a scheduler queue, not the clock's
      # thread, and the next track is picked while this one plays, so it
      # costs no audio; but the queue is held until a candidate is allowed
      # (see generic_queues below).
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
        complement_played_now(ch, m, now)
        starts := list.prefix(10, (list.assoc(default="", "filename", m), now)::starts())
      end
  )

  # Per track (on the playlist: the crossfaded source doesn't mark every
  # track): the play log. Asynchronous, so the listener count's HTTP call
  # never holds up the stream.
  tracks.on_track(
    synchronous=false,
    fun (m) ->
      begin
        t = track_info(slug, m)
        play =
          {
            time = list.assoc(default=time(), list.assoc(default="", "filename", m), starts()),
            show = slug,
            artist = t.artist,
            title = t.title,
            album = t.album,
            label = t.label,
            isrc = t.isrc,
            cover = t.cover,
            listeners = listeners(mount)
          }
        month = "#{time.string('%Y-%m')}"
        log_file = channel ? "#{month}.#{slug}" : month
        file.write(append=true, data="#{json.stringify(compact=true, play)}\n", "/plays/#{log_file}.jsonl")
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

shows = file.ls(absolute=true, sorted=true, pattern="*.md", "/shows")

# A playlist the complement holds back keeps one of the scheduler's generic
# queues busy until it can play (check_next above): a show's channel can be
# held for hours if it has few artists or albums. The queues also prepare
# every track and run the asynchronous on_track (the play log), so with the
# default 5 a few held channels starved the station. One per playlist (the
# station's and the channel's, per show), and the default 5 besides.
settings.scheduler.generic_queues := 2 * list.length(shows) + 5

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
station = complement_channel()
music =
  switch(
    track_sensitive=true,
    list.map(fun (f) -> (on_air(slug_of(f)), show(station, mount="stream", f)), shows)
  )

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

# Encoders get only the metadata keys listed here: add "song", or Icecast
# would build its own "Artist - Title".
settings.encoder.metadata.export := list.append(settings.encoder.metadata.export(), ["song"])

# A channel's final bus, sent to Icecast mount `mount`: crossfaded, never failing, limited, with its metadata in UTF-8 and
# the ICY title. icecast/silence.mp3 (Icecast's fallback while this restarts;
# see icecast/config.sh) is the same format: change both together.
def broadcast((mount:string), music) =
  music = crossfade(duration=12., fade_in=6., fade_out=6., music)

  # Limiter catches peaks from tracks autocue boosted and crossfade overlaps.
  radio = limit(mksafe(music))
  radio = metadata.map(fun (m) -> list.map(fun (kv) -> (fst(kv), safe_recode(snd(kv))), m), radio)
  radio = metadata.map(update=true, icy_song, radio)
  output.icecast(
    id=mount,
    %mp3(bitrate = 256),
    encoding="UTF-8",
    # Only "song" ("Artist - Title"), which Icecast shows players as the
    # StreamTitle. Sending artist and title too made Icecast warn on every
    # track that it got "song" but also "artist" and/or "title".
    icy_metadata=["song"],
    host="icecast",
    password=environment.get("PASSWORD"),
    mount=mount,
    radio
  )
end
broadcast("stream", music)

# Each show's own channel: its music around the clock.
list.iter(
  fun (f) ->
    begin
      mount = "stream/#{slug_of(f)}"
      broadcast(mount, show(complement_channel(), channel=true, mount=mount, f))
    end,
  shows
)

# The shows this process plays, for scripts/reconcile.sh to compare with /shows.
file.write(data=string.concat(separator="\n", shows), "/tmp/shows")
