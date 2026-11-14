// Show files and their DJs (app/shows.ts), on show files written here.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";

let shows: typeof import("./shows.ts");
let dir = "";

const SHOWS: Record<string, string> = {
  // A list: a bare name, a mapping with every field, a repeat, and DJs left out.
  "a-list.md": `---
title: A List
djs:
  - Ben Cho
  - name: Ana Ruiz
    tagline: Brooklyn, NY
    photo: djs/ana.jpg
    bio: Ana plays **records**.
    links:
      Instagram: https://instagram.com/anaruiz
      Bad: javascript:alert(1)
      Number: 42
  - Ben Cho
  - name: 李小龙
  - name: Bad Slug
    slug: Not A Slug
  - 12345
  - ""
---
The **first** show.
`,
  // One DJ, on one line.
  "b-dj.md": `---
title: B Dj
djs: [Ana Ruiz]
---
`,
  // One DJ with a slug of their own.
  "c-dj-map.md": `---
title: C Dj Map
djs:
  - name: 李小龙
    slug: bruce-lee
    tagline: Hong Kong
---
`,
  // Details for a DJ another show named first.
  "d-djs-one.md": `---
title: D Djs One
djs:
  - name: Ben Cho
    tagline: Queens, NY
    photo: ../outside.jpg
---
`,
  // Not a list: no DJs.
  "h-not-list.md": `---
title: H Not A List
djs: Ana Ruiz
dj: Ben Cho
---
`,
  // Accents, punctuation, and details a show earlier by slug already set.
  "e-accents.md": `---
djs:
  - name: "  Zoë Ñandú!  "
  - name: Ana Ruiz
    tagline: Elsewhere
    photo: djs/notes.txt
---
`,
  "e-plain.md": "Just a description.\n",
  "f-bad-yaml.md": "---\ntitle: [unclosed\n---\nBody.\n",
  "g-crlf.md": "---\r\ntitle: Windows\r\ndjs:\r\n  - Ana Ruiz\r\n---\r\nBody.\r\n",
  "manifesto.md": "---\ntitle: Reserved\n---\n",
  "Not-A-Show.md": "---\ntitle: Ignored\n---\n",
};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "shows-"));
  await mkdir(join(dir, "djs"));
  await writeFile(join(dir, "djs/ana.jpg"), "jpg");
  await writeFile(join(dir, "djs/notes.txt"), "txt");
  for (const [name, text] of Object.entries(SHOWS)) await writeFile(join(dir, name), text);
  process.env.SHOWS_DIR = dir;
  shows = await import("./shows.ts");
});

describe("shows", () => {
  test("are the show files with slug names, by slug, except reserved ones", async () => {
    expect((await shows.getShows()).map((s) => s.slug)).toEqual([
      "a-list",
      "b-dj",
      "c-dj-map",
      "d-djs-one",
      "e-accents",
      "e-plain",
      "f-bad-yaml",
      "g-crlf",
      "h-not-list",
    ]);
    expect(await shows.getShow("manifesto")).toBeUndefined();
    expect(await shows.getShow("nope")).toBeUndefined();
  });

  test("have their title and Markdown description", async () => {
    const show = await shows.getShow("a-list");
    expect(show?.title).toBe("A List");
    expect(show?.description).toBe("<p>The <strong>first</strong> show.</p>\n");
  });

  test("without front matter, a title, or with bad front matter, are titled by their slug", async () => {
    const plain = await shows.getShow("e-plain");
    expect(plain).toMatchObject({ title: "e-plain", description: "<p>Just a description.</p>\n" });
    expect((await shows.getShow("e-accents"))?.title).toBe("e-accents");
    expect((await shows.getShow("f-bad-yaml"))?.title).toBe("f-bad-yaml");
  });

  test("with CRLF line endings are read", async () => {
    const show = await shows.getShow("g-crlf");
    expect(show?.title).toBe("Windows");
    expect(show?.djs).toMatchObject([{ slug: "ana-ruiz", name: "Ana Ruiz" }]);
  });
});

describe("a show's DJs", () => {
  const djs = async (slug: string) =>
    (await shows.getShow(slug))?.djs.map(({ slug, name }) => ({ slug, name }));

  test("djs: a list of names and mappings, in order, without repeats or unusable slugs", async () => {
    expect(await djs("a-list")).toEqual([
      { slug: "ben-cho", name: "Ben Cho" },
      { slug: "ana-ruiz", name: "Ana Ruiz" },
      { slug: "12345", name: "12345" },
    ]);
  });

  test("one DJ on one line", async () => {
    expect(await djs("b-dj")).toEqual([{ slug: "ana-ruiz", name: "Ana Ruiz" }]);
  });

  test("one DJ with a slug of their own", async () => {
    expect(await djs("c-dj-map")).toEqual([{ slug: "bruce-lee", name: "李小龙" }]);
  });

  test("djs: that isn't a list, or dj:, is no DJs", async () => {
    expect(await djs("h-not-list")).toEqual([]);
  });

  test("slugs drop accents and punctuation, names are trimmed", async () => {
    expect(await djs("e-accents")).toEqual([
      { slug: "zoe-nandu", name: "Zoë Ñandú!" },
      { slug: "ana-ruiz", name: "Ana Ruiz" },
    ]);
  });

  test("no djs: is none", async () => {
    expect(await djs("f-bad-yaml")).toEqual([]);
  });
});

describe("a DJ", () => {
  test("has the details from their shows; the first show by slug that sets a field wins", async () => {
    const ana = await shows.getDj("ana-ruiz");
    expect(ana).toMatchObject({
      slug: "ana-ruiz",
      name: "Ana Ruiz",
      tagline: "Brooklyn, NY",
      bio: "Ana plays <strong>records</strong>.",
      photo: join(dir, "djs/ana.jpg"),
      links: [{ label: "Instagram", url: "https://instagram.com/anaruiz" }],
    });
    expect(ana?.shows.map((s) => s.slug)).toEqual(["a-list", "b-dj", "e-accents", "g-crlf"]);
  });

  test("details can come from a later show", async () => {
    const ben = await shows.getDj("ben-cho");
    expect(ben?.tagline).toBe("Queens, NY");
    expect(ben?.shows.map((s) => s.slug)).toEqual(["a-list", "d-djs-one"]);
  });

  test("photos outside shows/ or not images are left out", async () => {
    expect((await shows.getDj("ben-cho"))?.photo).toBeUndefined();
    expect((await shows.getDj("zoe-nandu"))?.photo).toBeUndefined();
  });

  test("with a slug of their own is found by it", async () => {
    expect(await shows.getDj("bruce-lee")).toMatchObject({ name: "李小龙", tagline: "Hong Kong", links: [] });
  });

  test("not on any show is undefined", async () => {
    expect(await shows.getDj("nobody")).toBeUndefined();
    expect(await shows.getDj("not-a-slug")).toBeUndefined();
  });
});
