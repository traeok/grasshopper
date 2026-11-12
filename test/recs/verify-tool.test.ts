import { expect, test } from "bun:test";
import { verifyTool } from "../../src/recs/verify-tool.ts";
import type { VerificationSpawnOptions, VerifyToolDeps } from "../../src/recs/verify-tool.ts";

function childResult(code: number, stdout = "", stderr = "") {
  return {
    exited: Promise.resolve(code),
    stdout: new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) { controller.enqueue(new TextEncoder().encode(stdout)); controller.close(); } }),
    stderr: new ReadableStream<Uint8Array<ArrayBuffer>>({ start(controller) { controller.enqueue(new TextEncoder().encode(stderr)); controller.close(); } }),
  };
}

test("GitHub license check uses public endpoint, required headers, and a timeout signal", async () => {
  const tool = await verifyTool({ name: "ripgrep", githubRepo: "BurntSushi/ripgrep" }, {
    fetch: async (url, init) => {
      expect(url).toBe("https://api.github.com/repos/BurntSushi/ripgrep");
      expect(init?.headers).toEqual({ "User-Agent": "grasshopper-cli", Accept: "application/vnd.github+json" });
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return Response.json({ license: { spdx_id: "MIT" } });
    },
  });
  expect(tool).toMatchObject({ name: "ripgrep", githubRepo: "BurntSushi/ripgrep", verification: { status: "verified", license: "MIT", checks: { github: "verified" } } });
  expect(Number.isNaN(Date.parse(tool?.verification.checkedAt ?? ""))).toBe(false);
});

test("GitHub follows the non-null license rule even for NOASSERTION", async () => {
  const tool = await verifyTool({ name: "tool", githubRepo: "owner/tool" }, {
    fetch: async () => Response.json({ license: { spdx_id: "NOASSERTION" } }),
  });
  expect(tool?.verification).toMatchObject({ status: "verified", license: "NOASSERTION" });
});

test("GitHub with no license is rejected", async () => {
  expect(await verifyTool({ name: "tool", githubRepo: "owner/tool" }, {
    fetch: async () => Response.json({ license: null }),
  })).toBeNull();
});

test.each([403, 429, 500])("GitHub HTTP %i is unknown", async status => {
  const tool = await verifyTool({ name: "tool", githubRepo: "owner/tool" }, { fetch: async () => new Response(null, { status }) });
  expect(tool?.verification).toMatchObject({ status: "unverified", license: null, checks: { github: "unknown" } });
});

test("network and malformed GitHub responses are unknown", async () => {
  const failed = await verifyTool({ name: "tool", githubRepo: "owner/tool", npmPackage: "tool" }, {
    fetch: async () => { throw new TypeError("network failure"); },
  });
  expect(failed?.verification.checks).toEqual({ github: "unknown", npm: "unknown" });
  const malformed = await verifyTool({ name: "tool", githubRepo: "owner/tool" }, { fetch: async () => new Response("not json") });
  expect(malformed?.verification.checks.github).toBe("unknown");
});

test("npm verifies scoped package identifiers with encoded slash", async () => {
  const tool = await verifyTool({ name: "tool", npmPackage: "@owner/tool" }, {
    fetch: async (url, init) => {
      expect(url).toBe("https://registry.npmjs.org/@owner%2Ftool");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(null, { status: 200 });
    },
  });
  expect(tool?.verification).toMatchObject({ status: "verified", checks: { npm: "verified" } });
});

test("npm 404 rejects and other unsuccessful statuses remain unknown", async () => {
  expect(await verifyTool({ name: "tool", npmPackage: "tool" }, { fetch: async () => new Response(null, { status: 404 }) })).toBeNull();
  const tool = await verifyTool({ name: "tool", npmPackage: "tool" }, { fetch: async () => new Response(null, { status: 429 }) });
  expect(tool?.verification.checks.npm).toBe("unknown");
});

test("all rejected identifiers drop the tool, while unknown identifiers preserve it", async () => {
  const tool = { name: "tool", githubRepo: "owner/tool", npmPackage: "tool", brewFormula: "tool" };
  expect(await verifyTool(tool, { fetch: async () => new Response(null, { status: 404 }) })).toBeNull();
  const partial = await verifyTool(tool, {
    fetch: async url => new Response(null, { status: url.includes("registry.npmjs.org") ? 403 : 404 }),
  });
  expect(partial?.verification).toMatchObject({ status: "unverified", checks: { github: "rejected", npm: "unknown", brew: "rejected" } });
});

test("one verified registry is sufficient despite another rejection", async () => {
  const tool = await verifyTool({ name: "tool", githubRepo: "owner/tool", npmPackage: "tool" }, {
    fetch: async url => new Response(null, { status: url.includes("registry.npmjs.org") ? 200 : 404 }),
  });
  expect(tool?.verification).toMatchObject({ status: "verified", checks: { github: "rejected", npm: "verified" } });
});

test("winget executes only its fixed show argv and inherits fixture environment", async () => {
  let called = false;
  const tool = await verifyTool({ name: "ripgrep", wingetId: "BurntSushi.ripgrep.MSVC" }, {
    platform: "win32", which: name => name === "winget" ? "fixture-winget.exe" : null,
    spawn: (argv, options) => {
      called = true;
      expect(argv).toEqual(["winget", "show", "--id", "BurntSushi.ripgrep.MSVC", "--exact", "--source", "winget", "--accept-source-agreements", "--disable-interactivity"]);
      expect(options).toMatchObject({ stdin: "ignore", stdout: "pipe", stderr: "pipe", windowsHide: true, timeout: 8000 });
      expect(options.env).toBe(process.env);
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return childResult(0);
    },
  });
  expect(called).toBe(true);
  expect(tool?.verification).toMatchObject({ status: "verified", checks: { winget: "verified" } });
});

test.each(["linux", "darwin"] as const)("winget on %s is unknown without probing or spawning", async platform => {
  const tool = await verifyTool({ name: "tool", wingetId: "Owner.Tool" }, {
    platform,
    which: () => { throw new Error("must not probe winget"); },
    spawn: () => { throw new Error("must not spawn winget"); },
  });
  expect(tool?.verification.checks.winget).toBe("unknown");
});

test("winget missing binary and spawn failures are unknown", async () => {
  const base = { name: "tool", wingetId: "Owner.Tool" };
  const missing = await verifyTool(base, {
    platform: "win32", which: () => null,
    spawn: () => { throw new Error("must not spawn missing binary"); },
  });
  expect(missing?.verification.checks.winget).toBe("unknown");
  const failed = await verifyTool(base, {
    platform: "win32", which: () => "fixture-winget.exe",
    spawn: () => { throw new Error("spawn failed"); },
  });
  expect(failed?.verification.checks.winget).toBe("unknown");
});

test.each(["stdout", "stderr"] as const)("winget no-package message on %s rejects", async stream => {
  const tool = await verifyTool({ name: "tool", wingetId: "Owner.Tool" }, {
    platform: "win32", which: () => "fixture-winget.exe",
    spawn: () => childResult(1, stream === "stdout" ? "No package found matching input criteria." : "", stream === "stderr" ? "NO PACKAGE FOUND" : ""),
  });
  expect(tool).toBeNull();
});

test("winget other failures remain unknown", async () => {
  const tool = await verifyTool({ name: "tool", wingetId: "Owner.Tool" }, {
    platform: "win32", which: () => "fixture-winget.exe", spawn: () => childResult(1, "", "Source unavailable"),
  });
  expect(tool?.verification.checks.winget).toBe("unknown");
});

test("brew formula success is checked once but alone does not verify source eligibility", async () => {
  const urls: string[] = [];
  const tool = await verifyTool({ name: "tool", brewFormula: "tool" }, {
    fetch: async (url, init) => {
      urls.push(url);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(null, { status: 200 });
    },
  });
  expect(urls).toEqual(["https://formulae.brew.sh/api/formula/tool.json"]);
  expect(tool?.verification).toMatchObject({ status: "unverified", checks: { brew: "verified" } });
});

test("brew falls back to cask with the same timeout signal", async () => {
  const requests: { url: string; signal: AbortSignal | null | undefined }[] = [];
  const tool = await verifyTool({ name: "tool", brewFormula: "tool" }, {
    fetch: async (url, init) => {
      requests.push({ url, signal: init?.signal });
      return new Response(null, { status: url.includes("/cask/") ? 200 : 404 });
    },
  });
  expect(requests.map(request => request.url)).toEqual(["https://formulae.brew.sh/api/formula/tool.json", "https://formulae.brew.sh/api/cask/tool.json"]);
  expect(requests[0]?.signal).toBe(requests[1]?.signal);
  expect(tool?.verification.checks.brew).toBe("verified");
});

test("brew needs two 404 responses to reject", async () => {
  expect(await verifyTool({ name: "tool", brewFormula: "tool" }, { fetch: async () => new Response(null, { status: 404 }) })).toBeNull();
  const unknown = await verifyTool({ name: "tool", brewFormula: "tool" }, {
    fetch: async url => new Response(null, { status: url.includes("/cask/") ? 404 : 500 }),
  });
  expect(unknown?.verification.checks.brew).toBe("unknown");
});

test("brew can verify a cask even when formula lookup has a network error", async () => {
  const tool = await verifyTool({ name: "tool", brewFormula: "tool" }, {
    fetch: async url => {
      if (url.includes("/formula/")) throw new TypeError("network failure");
      return new Response(null, { status: 200 });
    },
  });
  expect(tool?.verification.checks.brew).toBe("verified");
});

test("checks begin in parallel and preserve per-manager install verification", async () => {
  const pending: { url: string; resolve: (response: Response) => void }[] = [];
  let wingetOptions: VerificationSpawnOptions | undefined;
  const deps: VerifyToolDeps = {
    fetch: (url, init) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Promise<Response>(resolve => { pending.push({ url, resolve }); });
    },
    platform: "win32", which: () => "fixture-winget.exe",
    spawn: (_argv, options) => { wingetOptions = options; return childResult(0); },
  };
  const verification = verifyTool({ name: "tool", githubRepo: "owner/tool", npmPackage: "tool", wingetId: "Owner.Tool", brewFormula: "tool" }, deps);
  expect(pending).toHaveLength(3);
  expect(wingetOptions?.timeout).toBe(8000);
  for (const request of pending) {
    request.resolve(request.url.includes("api.github.com") ? Response.json({ license: { spdx_id: "MIT" } }) : new Response(null, { status: 200 }));
  }
  const tool = await verification;
  expect(tool?.verification).toMatchObject({ status: "verified", license: "MIT", checks: { github: "verified", npm: "verified", winget: "verified", brew: "verified" } });
});

test("no identifiers cannot establish a tool identity", async () => {
  expect(await verifyTool({ name: "tool" })).toBeNull();
});

test("invalid winget identifiers never reach a process", async () => {
  let spawned = false;
  await expect(verifyTool({ name: "tool", wingetId: "Owner.Tool;echo unsafe" }, {
    platform: "win32", which: () => "fixture-winget.exe", spawn: () => { spawned = true; return childResult(0); },
  })).rejects.toThrow();
  expect(spawned).toBe(false);
});
