// The archive's finished blocks: radio.liq moves each show block to
// archive/blocks when it ends, and scripts/prune-archive.sh takes them down.
// A show's own stream (/stream/<slug>) plays its blocks, so only a show with
// one has anything to play there.
import { readdir } from "node:fs/promises";
import { SLUG } from "./shows.ts";

const BLOCKS = `${process.env.ARCHIVE_DIR ?? "/archive"}/blocks`;
const BLOCK = new RegExp(`^(${SLUG})-\\d{4}-\\d{2}-\\d{2}\\.mp3$`);

// The shows with an archived block, by slug.
export async function archivedShows(): Promise<Set<string>> {
  const files = await readdir(BLOCKS).catch(() => [] as string[]);
  return new Set(files.flatMap((f) => BLOCK.exec(f)?.[1] ?? []));
}
