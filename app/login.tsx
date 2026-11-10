// Optional site password (SITE_PASSWORD): every page then needs a signed
// cookie, set by a small login form. /admin has its own basic auth; the
// streams (Caddy → Liquidsoap) stay public so apps like VLC can play them.
import type { Hono } from "hono";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
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

// At most 10 failed logins (site form or admin basic auth) per client IP per
// 15 minutes. Caddy sets X-Forwarded-For to the real client address.
const failures = new Map<string, number[]>();
export const throttle = createMiddleware(async (c, next) => {
  if (!/^\/(login|admin)(\/|$)/.test(c.req.path)) return next();
  const ip = c.req.header("x-forwarded-for") ?? "";
  const now = Date.now();
  const recent = (failures.get(ip) ?? []).filter((t) => now - t < 15 * 60_000);
  if (recent.length >= 10) return c.text("Too many attempts, try again later", 429);
  await next();
  if (c.res.status === 401 && (c.req.method === "POST" || c.req.header("authorization"))) recent.push(now);
  if (recent.length) failures.set(ip, recent);
  else failures.delete(ip);
});

export function login(app: Hono) {
  if (!PASSWORD) return;

  app.post("/login", async (c) => {
    const { password, next } = await c.req.parseBody();
    const to = typeof next === "string" && /^\/(?![/\\])/.test(next) && !/\p{Cc}/u.test(next) ? next : "/";
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
