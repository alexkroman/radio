// Log in once with the site password; every test starts with this cookie
// (playwright.config.ts storageState) unless it opts out.
import { request } from "@playwright/test";
import { BASE, SITE_PASSWORD } from "./helpers.ts";

export const STATE = "test-results/.auth.json";

export default async function globalSetup() {
  const context = await request.newContext({ baseURL: BASE, ignoreHTTPSErrors: true });
  const res = await context.post("/login", { form: { password: SITE_PASSWORD, next: "/" }, maxRedirects: 0 });
  if (res.status() !== 303) throw new Error(`login failed: ${res.status()}`);
  await context.storageState({ path: STATE });
  await context.dispose();
}
