// Optional site password (SITE_PASSWORD): every page then needs a signed
// cookie, set by a small login form. /admin has its own basic auth; the
// streams (Caddy → Liquidsoap) stay public so apps like VLC can play them.
import type { Hono } from "hono";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import { timingSafeEqual } from "hono/utils/buffer";

const PASSWORD = process.env.SITE_PASSWORD;
const COOKIE = "radio_auth";

const Login = ({ next, error }: { next: string; error?: boolean }) => (
  <article id="login">
    <h2>Radio</h2>
    <form method="post" action="/login">
      <input type="hidden" name="next" value={next} />
      <input
        type="password"
        name="password"
        placeholder="Password"
        aria-label="Password"
        autofocus
        required
      />
      <button type="submit">Enter</button>
      {error && <p>Wrong password</p>}
    </form>
  </article>
);

export function login(app: Hono) {
  if (!PASSWORD) return;

  app.post("/login", async (c) => {
    const { password, next } = await c.req.parseBody();
    const to = typeof next === "string" && /^\/(?![/\\])/.test(next) ? next : "/";
    if (typeof password !== "string" || !(await timingSafeEqual(password, PASSWORD))) {
      c.status(401);
      return c.render(<Login next={to} error />, { script: false });
    }
    await setSignedCookie(c, COOKIE, "1", PASSWORD, {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: 60 * 60 * 24 * 30,
    });
    return c.redirect(to, 303);
  });

  app.use(async (c, next) => {
    if (/^\/(assets|admin)(\/|$)/.test(c.req.path) || (await getSignedCookie(c, PASSWORD, COOKIE)) === "1")
      return next();
    c.status(401);
    return c.render(<Login next={c.req.path} />, { script: false });
  });
}
