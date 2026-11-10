enable_autocue_metadata()
live = blank.strip(input.harbor("live", port=8005, password=environment.get("LIVE_PASSWORD")))
music = crossfade(duration=12., fade_in=6., fade_out=6., amplify(1., playlist(mode="randomize", reload_mode="watch", check_next=fun(r) -> not string.contains(suffix=".gitkeep", request.uri(r)), "/music")))
fade = fun (a, b) -> add(normalize=false, [fade.out(a), fade.in(b)])
radio = mksafe(fallback(track_sensitive=false, transitions=[fade, fade], [live, music]))

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
  end)
output.icecast(%mp3(bitrate=128), host="icecast", password=environment.get("PASSWORD"), mount="stream", radio)
