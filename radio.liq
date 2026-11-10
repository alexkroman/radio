enable_autocue_metadata()
live = blank.strip(input.harbor("live", port=8005, password=environment.get("LIVE_PASSWORD")))
# Artist separation: reject a candidate track if any of its artists (split on
# ",", "&", "feat.", "x", "with") was among the last 20 artists played. Falls
# back to the "Artist- Title" filename when the file has no artist tag.
recent_artists = ref([])

def track_artists(r) =
  a = list.assoc(default="", "artist", request.metadata(r))
  a = if a != "" then a else list.hd(default="", string.split(separator="- ", path.basename(request.uri(r)))) end
  parts = string.split(separator=",|&| feat\\.? | ft\\.? | x | with ", string.case(lower=true, a))
  list.filter(fun(x) -> x != "", list.map(string.trim, parts))
end

def artist_not_recent(r) =
  artists = track_artists(r)
  if list.exists(fun(a) -> list.mem(a, recent_artists()), artists) then
    log.info(label="separation", "Skipping #{path.basename(request.uri(r))}: artist played recently")
    false
  else true end
end

# Shows: each shows/<slug>.md plays music/<slug>/. Its front matter may set
# `when:` as Liquidsoap time terms joined by " and " (e.g. "1w-5w and 6h-10h",
# 1w = Monday, hours in TZ). Shows with more terms win; no `when:` = any time.
# Edits to shows/ need `docker compose restart liquidsoap`.
# Loudness: autocue measures each track and sets liq_amplify (gain to reach
# -14 LUFS); amplify applies it via its default override="liq_amplify".
def show(f) =
  s = file.contents(f)
  m = regexp(flags=["m"], "^when:[ \\t]*(.*?)[ \\t]*$").exec(s)
  terms = list.filter(fun(x) -> x != "", string.split(separator=" and ", list.assoc(default="", 1, m)))
  preds = list.map(time.predicate, terms)
  dir = "/music/#{path.remove_extension(path.basename(f))}"
  (list.length(terms), ({list.for_all(fun(p) -> p(), preds)}, amplify(1., playlist(mode="randomize", reload_mode="watch", check_next=fun(r) -> not string.contains(suffix=".gitkeep", request.uri(r)) and artist_not_recent(r), dir))))
end
shows = list.sort(fun(a, b) -> fst(b) - fst(a), list.map(show, file.ls(absolute=true, pattern="*.md", "/shows")))
music = crossfade(duration=12., fade_in=6., fade_out=6., switch(list.map(snd, shows)))
fade = fun (a, b) -> add(normalize=false, [fade.out(a), fade.in(b)])
# Limiter catches peaks from tracks autocue boosted and crossfade overlaps.
radio = limit(mksafe(fallback(track_sensitive=false, transitions=[fade, fade], [live, music])))

def safe_recode(s) =
  if string.bytes.length(s) > 1024 then s
  else
    try string.recode(s) catch e do s end
  end
end

radio = metadata.map(fun(m) -> list.map(fun(kv) -> (fst(kv), safe_recode(snd(kv))), m), radio)
radio.on_track(fun(m) ->
  begin
    cover = metadata.cover(m)
    if null.defined(cover) then
      file.write(data=null.get(cover), "/covers/cover.jpg")
    else
      if file.exists("/covers/cover.jpg") then
        file.remove("/covers/cover.jpg")
      end
    end

    a = list.assoc(default="", "artist", m)
    if a != "" then
      parts = string.split(separator=",|&| feat\\.? | ft\\.? | x | with ", string.case(lower=true, a))
      artists = list.filter(fun(x) -> x != "", list.map(string.trim, parts))
      recent_artists := list.prefix(20, list.append(artists, recent_artists()))
    end
  end)
output.icecast(%mp3(bitrate=256), host="icecast", password=environment.get("PASSWORD"), mount="stream", radio)
