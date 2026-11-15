// Shows (shows/<slug>.md) and their DJs, which are declared in the shows'
// front matter:
//
//   djs:
//     - name: Ana Ruiz              # the page is /djs/ana-ruiz
//       tagline: Brooklyn, NY
//       photo: djs/ana-ruiz.jpg     # relative to shows/
//       bio: Two or three sentences (Markdown).
//       links:
//         Instagram: https://instagram.com/anaruiz
//     - Ben Cho                     # just a name
//     - name: 李小龙
//       slug: bruce-lee            # for a name that makes no usable slug
//
// A show with one DJ lists just them (`djs: [Ana Ruiz]` on one line).
//
// Its hours on the station's one stream: `hours: 6-17` (whole hours, 24-hour
// clock, local time (TZ), the end not included; 22-6 runs past midnight, 0-24
// all day). radio.liq reads them the same way; app/schedule.ts checks that the
// shows cover every hour exactly once.
//
// The slug is the name lowercased, without accents, non-alphanumerics as "-"
// ("Zoë Ñandú" → zoe-nandu); a DJ with no usable slug is left out, as is a
// repeat of a DJ already on the show. A DJ on several shows is one page; their
// details can be written on any of those shows (the first show, by slug, that
// sets a field wins).
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { marked } from "marked";
import { parse as parseYaml } from "yaml";

const SHOWS = resolve(process.env.SHOWS_DIR ?? "/shows");
export const SLUG = "[a-z0-9-]+";
const SHOW_FILE = new RegExp(`^${SLUG}\\.md$`);
// Pages with their own routes; a show with one of these slugs isn't listed.
const RESERVED = new Set(["about", "assets", "covers", "djs", "login", "manifesto", "reports", "stream"]);
// DJ photos: image files (served by serveStatic, which types them by extension).
const PHOTO_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif", ".gif"]);

export type DjRef = { slug: string; name: string };
// A show's DJs keep the details written for them there, for getDj.
// Hours: [start, end) on the 24-hour clock (see above).
export type Hours = [number, number];
export type Show = {
  slug: string;
  title: string;
  description: string;
  djs: DjEntry[];
  hours?: Hours;
  badHours?: string; // the `hours:` written, when it isn't valid
};
export type Dj = DjRef & {
  tagline?: string;
  bio?: string; // HTML
  photo?: string; // absolute path to the file
  links: { label: string; url: string }[];
  shows: Show[];
};

// Front-matter fields of one `djs:` entry, before merging across shows.
type DjEntry = DjRef & Partial<Pick<Dj, "tagline" | "bio" | "photo" | "links">>;

const str = (v: unknown) =>
  typeof v === "string" || typeof v === "number" ? String(v).trim() || undefined : undefined;

const slugify = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

function djEntry(v: unknown): DjEntry | undefined {
  const o = (typeof v === "object" && v !== null ? v : { name: v }) as Record<string, unknown>;
  const name = str(o["name"]);
  if (!name) return undefined;
  const slug = slugify(name);
  if (!new RegExp(`^${SLUG}$`).test(slug)) return undefined;
  const photoFile = str(o["photo"]);
  const photo = photoFile && resolve(SHOWS, photoFile);
  const bio = str(o["bio"]);
  const links =
    typeof o["links"] === "object" && o["links"] !== null
      ? Object.entries(o["links"]).flatMap(([label, url]) =>
          typeof url === "string" && /^https?:\/\//i.test(url) ? [{ label, url }] : [],
        )
      : [];
  return {
    slug,
    name,
    tagline: str(o["tagline"]),
    bio: bio && (marked.parseInline(bio) as string),
    // Only image files inside shows/.
    photo:
      photo?.startsWith(SHOWS + sep) && PHOTO_EXTENSIONS.has(extname(photo).toLowerCase())
        ? photo
        : undefined,
    links: links.length ? links : undefined,
  };
}

// `hours:` as Hours, or undefined if it isn't "<start>-<end>" with
// 0 <= start < 24, 0 < end <= 24 and start != end.
export function parseHours(v: unknown): Hours | undefined {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(typeof v === "string" ? v : "");
  if (!m) return undefined;
  const [start, end] = [Number(m[1]), Number(m[2])];
  return start < 24 && end <= 24 && start !== end ? [start, end] : undefined;
}

// Parsed shows, re-read only when a file changes (every page renders the show
// list, and polls re-render pages every 15 s). The inode is in the key since
// rsync (deploy.sh) replaces a file, keeping the source's mtime.
const cache = new Map<string, { key: string; show: Promise<Show> }>();

export async function getShow(slug: string): Promise<Show | undefined> {
  if (RESERVED.has(slug)) return undefined;
  const file = `${SHOWS}/${slug}.md`;
  const st = await stat(file).catch(() => undefined);
  if (!st?.isFile()) {
    cache.delete(slug);
    return undefined;
  }
  const key = `${st.ino}:${st.mtimeMs}:${st.size}`;
  let hit = cache.get(slug);
  if (hit?.key !== key) {
    const entry = { key, show: readFile(file, "utf8").then((text) => parseShow(slug, text)) };
    cache.set(slug, entry);
    entry.show.catch(() => cache.get(slug) === entry && cache.delete(slug));
    hit = entry;
  }
  return hit.show.catch(() => undefined);
}

async function parseShow(slug: string, text: string): Promise<Show> {
  const md = text.replace(/\r\n?/g, "\n");
  const [, front = "", body = md] = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(md) ?? [];
  let meta: Record<string, unknown> = {};
  try {
    const parsed: unknown = parseYaml(front);
    if (typeof parsed === "object" && parsed !== null) meta = parsed as Record<string, unknown>;
  } catch {
    // Invalid front matter: fall back to the slug as the title.
  }
  const djs = meta["djs"];
  const entries: DjEntry[] = (Array.isArray(djs) ? djs : [])
    .map(djEntry)
    .filter((d) => d !== undefined)
    .filter((d, i, all) => all.findIndex((e) => e.slug === d.slug) === i);
  const hours = parseHours(meta["hours"]);
  return {
    slug,
    title: str(meta["title"]) ?? slug,
    description: await marked.parse(body),
    djs: entries,
    hours,
    badHours: hours || meta["hours"] === undefined ? undefined : String(meta["hours"]),
  };
}

export async function getShows(): Promise<Show[]> {
  const files = (await readdir(SHOWS)).filter((f) => SHOW_FILE.test(f)).sort();
  return (await Promise.all(files.map((f) => getShow(f.slice(0, -3))))).filter((s) => s !== undefined);
}

export async function getDj(slug: string): Promise<Dj | undefined> {
  let dj: Dj | undefined;
  for (const show of await getShows()) {
    const entry = show.djs.find((e) => e.slug === slug);
    if (!entry) continue;
    dj ??= { slug, name: entry.name, links: [], shows: [] };
    dj.tagline ??= entry.tagline;
    dj.bio ??= entry.bio;
    dj.photo ??= entry.photo;
    if (!dj.links.length && entry.links) dj.links = entry.links;
    dj.shows.push(show);
  }
  return dj;
}
