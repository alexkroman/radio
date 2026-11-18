# The harness for test/block-stream.sh: radio.liq's own block_stream, and
# the helpers it uses that are plain functions, are pasted in after this
# part; only what reaches outside (Icecast, the play log, the archive's
# paths) is replaced here. Each show's stream goes to /w/out/<slug>.wav, as
# fast as it can be computed, and each track it starts to
# /w/out/<slug>.jsonl, with when it started in the stream (the source's
# clock).
settings.log.level := 2
archive_blocks = "/w/blocks"
archive_tracks = "/w/tracks"

# The play log's tags (radio.liq track_info reads the same keys).
def track_info(_, m) =
  {title = list.assoc(default="", "title", m)}
end
def play_log(_, _) =
  fun (_, _, _) -> ()
end

# How much of each stream to compute, by slug, from its first track (before
# it, the stream's fallback starts a silent one): its block once, and for
# seams the next block's start (the same block again).
lengths = [("seams", 33.), ("long", 1801.)]
running = ref(list.length(lengths))

def to_icecast((mount:string), s) =
  slug = list.nth(string.split(separator="/", mount), 1)
  s = source.methods(s)
  clock.assign_new(sync="none", [s])
  started = ref(-1.)
  s.on_track(
    synchronous=true,
    fun (m) ->
      begin
        if started() < 0. and list.assoc(default="", "title", m) != "" then started := s.time() end
        file.write(
          append=true,
          data=json.stringify(
            compact=true,
            {
              at = s.time(),
              title = list.assoc(default="", "title", m),
              artist = list.assoc(default="", "artist", m),
              album = list.assoc(default="", "album", m),
              label = list.assoc(default="", "label", m),
              isrc = list.assoc(default="", "isrc", m),
              cover = list.assoc(default="", "archive_cover", m),
              song = list.assoc(default="", "song", m)
            }
          ) ^
            "\n",
          "/w/out/#{slug}.jsonl"
        )
      end
  )
  o = output.file(%wav(stereo, samplerate = 44100), "/w/out/#{slug}.wav", fallible=true, s)
  done = ref(false)
  s.on_frame(
    synchronous=true,
    fun () ->
      if
        not done() and started() >= 0. and s.time() - started() >= list.assoc(slug, lengths)
      then
        done := true
        o.stop()
        running := running() - 1
        if running() == 0 then shutdown() end
      end
  )
end
