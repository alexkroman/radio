// Optional site password (SITE_PASSWORD): every page then needs a signed
// cookie, set by a small login form. /admin has its own basic auth; assets,
// favicons and the streams (Caddy → Liquidsoap) stay public so apps like VLC
// can play them.
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { except } from "hono/combine";
import { getSignedCookie, setSignedCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import { timingSafeEqual } from "hono/utils/buffer";
import { Lockup } from "./ui.tsx";

const PASSWORD = process.env.SITE_PASSWORD;
const COOKIE = "radio_auth";

const Login = ({ next, error }: { next: string; error?: boolean }) => (
  <main class="page page-login">
    <Lockup />
    <form method="post" action="/login" class="login">
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
      {error && <p class="error">Wrong password</p>}
    </form>
  </main>
);

// At most 10 failed logins (site form or admin basic auth) per client IP per
// 15 minutes. Caddy sets X-Forwarded-For to the real client address. An
// attempt counts from when it starts (and is dropped if it succeeds), so
// attempts sent all at once can't get past the limit.
const WINDOW = 15 * 60_000;
const attempts = new Map<string, number[]>();
export const throttle = createMiddleware(async (c, next) => {
  const ip = c.req.header("x-forwarded-for") ?? "";
  const now = Date.now();
  let times = attempts.get(ip);
  if (!times) attempts.set(ip, (times = []));
  while (times.length && now - times[0]! >= WINDOW) times.shift();
  if (times.length >= 10) return c.text("Too many attempts, try again later", 429);
  const attempt = c.req.method === "POST" || !!c.req.header("authorization");
  if (attempt) times.push(now);
  try {
    await next();
  } finally {
    if (attempt && c.res.status !== 401) times.splice(times.indexOf(now), 1);
    if (!times.length) attempts.delete(ip);
  }
});

export function login(app: Hono) {
  if (!PASSWORD) return;

  // The form is a password and a path: anything bigger isn't read.
  const limit = bodyLimit({ maxSize: 4096, onError: (c) => c.text("Too large", 413) });
  app.post("/login", limit, async (c) => {
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

  app.use(
    except(
      ["/assets/*", "/admin/*", "/favicon.ico", "/favicon.svg", "/apple-touch-icon.png"],
      async (c, next) => {
        if ((await getSignedCookie(c, PASSWORD, COOKIE)) === "1") return next();
        c.status(401);
        return c.render(<Login next={c.req.path} />, { script: false });
      },
    ),
  );
}
