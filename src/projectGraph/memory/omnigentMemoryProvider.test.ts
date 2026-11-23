import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as IdentityModule from "@/lib/identity";

interface Call {
  method: string;
  path: string;
  body: unknown;
}
const server = vi.hoisted(() => ({
  calls: [] as Call[],
  respond: (_call: Call): { status: number; json?: unknown; text?: string } => ({ status: 404 }),
}));
vi.mock("@/lib/identity", async (importOriginal) => {
  const actual = await importOriginal<typeof IdentityModule>();
  return {
    ...actual,
    authenticatedFetch: vi.fn(async (path: string, init: RequestInit = {}) => {
      const call = {
        method: init.method ?? "GET",
        path,
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      };
      server.calls.push(call);
      const { status, json, text } = server.respond(call);
      return new Response(text ?? JSON.stringify(json ?? {}), { status });
    }),
  };
});

const {
  omnigentMemoryProvider: provider,
  omnigentNameProblem,
  omnigentProjectProblem,
} = await import("./omnigentMemoryProvider");

const wire = (path: string, description: string | null = null, content = "") => ({
  path,
  content,
  description,
  created_at: 10,
  updated_at: 20,
});

beforeEach(() => {
  server.calls = [];
  server.respond = () => ({ status: 404 });
});

describe("status", () => {
  it("is off, with the setting to turn on, when the routes answer 404", async () => {
    const status = await provider.status();
    expect(status.state).toBe("off");
    expect(status.state === "off" && status.help.steps[0]?.code).toBe("OMNIGENT_FEATURES=memory");
    // Nothing is probed past the first 404.
    expect(server.calls).toHaveLength(1);
  });

  it("is off when the route answers with something that isn't a memory listing", async () => {
    server.respond = () => ({ status: 200, json: { object: "list", data: [] } });
    expect((await provider.status()).state).toBe("off");
    server.respond = () => ({ status: 200, text: "<!doctype html>" });
    expect((await provider.status()).state).toBe("off");
  });

  it("is ready without search on the default backend", async () => {
    server.respond = (call) =>
      call.path.startsWith("/v1/memory/entries")
        ? { status: 200, json: { entries: [] } }
        : { status: 404 };
    expect(await provider.status()).toEqual({ state: "ready", search: false });
  });

  it("is ready with search on a backend that ranks", async () => {
    server.respond = (call) =>
      call.path.startsWith("/v1/memory/entries")
        ? { status: 200, json: { entries: [] } }
        : { status: 200, json: { hits: [] } };
    expect(await provider.status()).toEqual({ state: "ready", search: true });
  });

  it("fails, rather than claim memory is off, on any other error", async () => {
    server.respond = () => ({
      status: 403,
      json: { error: { message: "Sign in to use memory" } },
    });
    await expect(provider.status()).rejects.toThrow("Couldn’t reach memory: Sign in to use memory");
  });
});

describe("reading", () => {
  it("lists a project's entries by their name under the project", async () => {
    server.respond = () => ({
      status: 200,
      json: {
        entries: [wire("/projects/api/deploy/gotchas", "Things that broke")],
        next_page_token: "next",
      },
    });
    expect(await provider.list("api", "tok")).toEqual({
      entries: [
        {
          id: "/projects/api/deploy/gotchas",
          name: "deploy/gotchas",
          description: "Things that broke",
          updatedAt: 20,
        },
      ],
      nextPageToken: "next",
    });
    const params = new URLSearchParams(server.calls[0]!.path.split("?")[1]);
    expect(Object.fromEntries(params)).toEqual({
      prefix: "/projects/api",
      page_size: "100",
      page_token: "tok",
    });
  });

  it("refuses a project name the server would reject, without a request", async () => {
    await expect(provider.list("../user", null)).rejects.toThrow("The project name");
    expect(server.calls).toEqual([]);
  });

  it("returns null for an entry that is gone", async () => {
    expect(await provider.get("api", "/projects/api/gone")).toBeNull();
    expect(server.calls[0]!.path).toBe("/v1/memory/entry?path=%2Fprojects%2Fapi%2Fgone");
  });

  it("searches within the project", async () => {
    server.respond = () => ({
      status: 200,
      json: { hits: [{ entry: wire("/projects/api/notes"), score: 0.9 }] },
    });
    expect((await provider.search!("api", "deploy")).map((hit) => hit.name)).toEqual(["notes"]);
    expect(server.calls[0]!.body).toEqual({
      query: "deploy",
      path_prefix: "/projects/api",
      limit: 50,
    });
  });

  it("suggests the projects that already hold memories", async () => {
    server.respond = () => ({
      status: 200,
      json: {
        entries: [
          wire("/projects/api/a"),
          wire("/projects/api/b"),
          wire("/projects/web/c"),
          // Not under a project: a bare entry and another root.
          wire("/projects/loose"),
          wire("/user/style"),
        ],
      },
    });
    expect(await provider.projects!()).toEqual(["api", "web"]);
  });
});

describe("writing", () => {
  it("creates an entry at the project's path", async () => {
    server.respond = (call) => ({
      status: 200,
      json: wire((call.body as { path: string }).path, "d", "body"),
    });
    const saved = await provider.write!("api", {
      name: "deploy/gotchas",
      content: "body",
      description: "d",
    });
    expect(server.calls[0]).toEqual({
      method: "PUT",
      path: "/v1/memory/entry",
      body: { path: "/projects/api/deploy/gotchas", content: "body", description: "d" },
    });
    expect(saved).toMatchObject({ name: "deploy/gotchas", content: "body" });
  });

  it("writes an edit back to the path it read, whatever the name says", async () => {
    server.respond = (call) => ({ status: 200, json: wire((call.body as { path: string }).path) });
    await provider.write!("api", {
      id: "/projects/api/notes",
      name: "renamed",
      content: "body",
      description: null,
    });
    expect((server.calls[0]!.body as { path: string }).path).toBe("/projects/api/notes");
  });

  it("reports the server's reason when a write is refused", async () => {
    server.respond = () => ({ status: 400, json: { error: { message: "content is required" } } });
    await expect(
      provider.write!("api", { name: "notes", content: " ", description: null }),
    ).rejects.toThrow("Couldn’t save the memory: content is required");
  });

  it("deletes by path", async () => {
    server.respond = () => ({ status: 200, json: { deleted: true } });
    await provider.remove!("api", "/projects/api/notes");
    expect(server.calls[0]).toMatchObject({
      method: "DELETE",
      path: "/v1/memory/entry?path=%2Fprojects%2Fapi%2Fnotes",
    });
  });
});

describe("names", () => {
  it("accepts what the server accepts", () => {
    for (const name of ["notes", "deploy/gotchas", "v1.2 plan", "naïve_café-9"]) {
      expect(omnigentNameProblem(name)).toBeNull();
    }
    expect(omnigentProjectProblem("my repo")).toBeNull();
  });

  it("rejects what the server rejects", () => {
    for (const name of ["", "/lead", "trail/", "a//b", "a/../b", "a/./b", "semi;colon", "a/ b"]) {
      expect(omnigentNameProblem(name)).not.toBeNull();
    }
    expect(omnigentNameProblem("x".repeat(600), "api")).toContain("too long");
    expect(omnigentProjectProblem("a/b")).not.toBeNull();
  });
});
