import { test, expect } from "bun:test";
import { join } from "node:path";
import { readFileSync, readdirSync } from "node:fs";
import { z } from "zod";
import { withTempHome } from "../helpers/env.ts";
import { writeTextAtomic, readJson } from "../../src/core/fsx.ts";
import { tryLock } from "../../src/core/lock.ts";

test("atomic replacement and corrupt configuration recovery", async () => {
  await withTempHome(home => {
    const file = join(home, "config.json");
    writeTextAtomic(file, '{"n":1}\n');
    writeTextAtomic(file, '{"n":2}\n');
    expect(readFileSync(file, "utf8")).toBe('{"n":2}\n');
    const schema = z.object({ n: z.number() });
    expect(readJson(file, schema, { n: 0 })).toEqual({ n: 2 });
    writeTextAtomic(file, "invalid");
    expect(readJson(file, schema, { n: 0 })).toEqual({ n: 0 });
    expect(readdirSync(home).some(f => f.startsWith("config.json.corrupt-"))).toBe(true);
  });
});
test("lock excludes simultaneous claims and allows release", async () => {
  await withTempHome(() => {
    const release = tryLock("test", 60000);
    expect(release).not.toBeNull();
    expect(tryLock("test", 60000)).toBeNull();
    release!();
    const again = tryLock("test", 60000);
    expect(again).not.toBeNull();
    again!();
  });
});
