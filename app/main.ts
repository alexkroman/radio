// Entry point: serves the app (app/server.tsx) on port 3000, behind Caddy.
import { serve } from "@hono/node-server";
import { app } from "./server.tsx";

serve({ fetch: app.fetch, port: 3000 });
