import { z, ZodError } from "zod";
import {
  HttpError,
  httpErrorResponse,
  notFound,
  reportError,
  toAppLocale,
  validationError,
} from "@intgetion/kit";
import * as briefs from "../modules/briefs/service";
import { isUuid, requireServiceToken } from "./auth";

export type AppConfig = { serviceToken: string };

const MAX_JSON = 8 * 1024;
const slotBody = z
  .object({ timezone: z.string().min(1).max(64), localTime: z.string().max(8), enabled: z.boolean() })
  .strict();
const pausedBody = z.object({ paused: z.boolean() }).strict();
const runBody = z.object({ dryRun: z.boolean().default(true) }).strict();
const adminHeader = "x-user-id";

async function parseBody<T>(request: Request, schema: z.ZodType<T>): Promise<T> {
  const text = await request.text();
  if (text.length > MAX_JSON) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "Body too large");
  }
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw validationError({ body: "invalid json" });
  }
  return schema.parse(json);
}

/** The platform checked admin rights and audits the action; it names the admin. */
function adminId(request: Request): string {
  const id = request.headers.get(adminHeader);
  if (!id || !isUuid(id)) throw new HttpError(401, "UNAUTHENTICATED", "Missing admin id");
  return id;
}

type Route = {
  method: string;
  pattern: RegExp;
  run: (request: Request, params: string[], url: URL) => Promise<unknown>;
};

const routes: Route[] = [
  {
    method: "POST",
    pattern: /^\/v1\/tasks\/run-briefs$/,
    run: async () => briefs.runMorningBriefsCron(),
  },
  {
    method: "GET",
    pattern: /^\/v1\/admin$/,
    run: async () => briefs.readBriefsAdmin(),
  },
  {
    method: "PUT",
    pattern: /^\/v1\/admin\/settings$/,
    run: async (request) => {
      const admin = adminId(request);
      const { paused } = await parseBody(request, pausedBody);
      return briefs.setBriefsPaused(admin, paused);
    },
  },
  {
    method: "PATCH",
    pattern: /^\/v1\/admin\/slots\/([^/]+)$/,
    run: async (request, [id]) => {
      const admin = adminId(request);
      const input = await parseBody(request, slotBody);
      return briefs.updateBriefSlot(admin, id ?? "", input);
    },
  },
  {
    method: "POST",
    pattern: /^\/v1\/admin\/slots\/([^/]+)\/run$/,
    run: async (request, [id]) => {
      adminId(request);
      const { dryRun } = await parseBody(request, runBody);
      return briefs.runBriefSlotNow(id ?? "", dryRun);
    },
  },
  {
    method: "GET",
    pattern: /^\/v1\/jobs\/([^/]+)\/candidate-cards$/,
    run: async (_request, [jobId], url) => {
      if (!jobId || !isUuid(jobId)) throw notFound();
      return {
        cards: await briefs.listJobCandidateCards(jobId, toAppLocale(url.searchParams.get("locale"))),
      };
    },
  },
];

export function toResponse(error: unknown): Response {
  if (error instanceof HttpError) return httpErrorResponse(error);
  if (error instanceof ZodError) {
    return httpErrorResponse(validationError(error.issues));
  }
  reportError(error, "briefs-service");
  return Response.json(
    { error: { code: "INTERNAL", message: "Internal error" } },
    { status: 500 },
  );
}

export function createApp(config: AppConfig) {
  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/health") {
        return Response.json({ ok: true });
      }
      requireServiceToken(request, config.serviceToken);
      for (const route of routes) {
        if (route.method !== request.method) continue;
        const match = route.pattern.exec(url.pathname);
        if (!match) continue;
        return Response.json(await route.run(request, match.slice(1), url), {
          headers: { "cache-control": "no-store" },
        });
      }
      throw notFound();
    } catch (error) {
      return toResponse(error);
    }
  };
}
