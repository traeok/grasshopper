import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConfigSchema } from "../../src/core/config.ts";
import { EgressBlockedError } from "../../src/core/errors.ts";
import { STATIC_SYSTEM_PROMPTS } from "../../src/llm/prompts.ts";
import { buildProfile } from "../../src/profile/build.ts";
import { detectEnvironment } from "../../src/profile/environment.ts";
import { assertOutboundSafe, isSafeString, isSafeToken, redactOutboundText, validateProfile } from "../../src/privacy/egress.ts";
import { harvestSensitiveLiterals, type SensitiveLiteral } from "../../src/privacy/literals.ts";
import { SECRET_RULES } from "../../src/privacy/secret-rules.ts";
import { withTempHome } from "../helpers/env.ts";

const GITHUB_TOKEN = "ghp_Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LzXcVb";
const ENTROPY_TOKEN = "AbCdEfGhIjKlMnOpQr01AbCd";

function fixtureProfile() {
  const entries = Array.from({ length: 6 }, (_, seq) => ({ text: "git status", seq, ts: null, durationSec: null }));
  const dumps = { aliases: [], functions: [], info: {}, capturedAt: null };
  return buildProfile({ entries, source: { shell: "bash", file: "fixture" }, dumps,
    ledger: { firstUntimedDay: null, days: {} }, existing: [], config: ConfigSchema.parse({}),
    env: detectEnvironment("bash", dumps, () => null), fresh: entries, salt: "fixture-salt" }).profile;
}

function blockedCategories(fn: () => void): string[] {
  try { fn(); } catch (error) {
    expect(error).toBeInstanceOf(EgressBlockedError);
    return (error as EgressBlockedError).categories;
  }
  throw new Error("Expected the egress guard to block");
}

describe("profile wire grammar", () => {
  test("re-exports the shared token and string grammar", () => withTempHome(() => {
    for (const token of ["git", "--force-with-lease", "-Abcd", "--output=<val>", "<path#999>", "NODE_ENV=<val>", "<var#2>=<val>", "2>&1", "5.2.37"]) {
      expect(isSafeToken(token)).toBe(true);
    }
    for (const token of ["constructor", "__proto__", "toString", "acmecorp", "--private-project", "<path#1000>", "SECRET=<val>"]) {
      expect(isSafeToken(token)).toBe(false);
    }
    expect(isSafeString("git status | cat <path#1>")).toBe(true);
    expect(isSafeString("git acmecorp")).toBe(false);
    expect(isSafeString("git\nstatus")).toBe(false);
  }));

  test("accepts a built profile and every narrowly scoped exemption", () => withTempHome(() => {
    const profile = fixtureProfile();
    profile.typos = [{ typed: "gti", meant: "git", n: 2 }, { typed: "git psuh", meant: "git push", n: 2 }];
    profile.memory = ["gh:owner/public-tool", "npm:@scope/public-tool", "winget:Vendor.PublicTool", "brew:public-tool@2"].map(tool => ({
      category: "tool", status: "discarded", evidence: ["template:git status", "history:ignoreSpace"], tool,
    }));
    expect(() => validateProfile(profile)).not.toThrow();
  }));

  test("rejects arbitrary strings with only the field path in the error", () => withTempHome(() => {
    const profile = fixtureProfile();
    profile.templates[0]!.t = "git acmecorp";
    expect(blockedCategories(() => validateProfile(profile))).toEqual(["grammar:$.templates[0].t"]);
  }));

  test("rejects unsafe own object keys without echoing them", () => withTempHome(() => {
    for (const key of ["acmecorp-secret-key", "constructor", "__proto__"]) {
      const profile = fixtureProfile();
      profile.environment.options = JSON.parse(`{"${key}":true}`) as Record<string, boolean>;
      const categories = blockedCategories(() => validateProfile(profile));
      expect(categories).toEqual(["grammar:$.environment.options[key#0]"]);
      expect(categories.join()).not.toContain(key);
    }
  }));

  test("typo exemption requires a safe intended word and close same-position tokens", () => withTempHome(() => {
    for (const [typed, meant] of [["acmecorp", "git"], ["git pssshh", "git push"], ["git psuh extra", "git push"], ["gti", "acmecorp"], ["Gti", "git"]]) {
      const profile = fixtureProfile();
      profile.typos = [{ typed: typed!, meant: meant!, n: 2 }];
      expect(() => validateProfile(profile)).toThrow(EgressBlockedError);
    }
  }));

  test("memory evidence must be current and public identifiers match the exact grammar", () => withTempHome(() => {
    for (const evidence of ["signal:doesNotExist", "template:git acmecorp", "history:shared"]) {
      const profile = fixtureProfile();
      profile.memory = [{ category: "tip", status: "new", evidence: [evidence], tool: null }];
      expect(blockedCategories(() => validateProfile(profile))).toEqual(["grammar:$.memory[0].evidence[0]"]);
    }
    for (const tool of ["https://internal.example/tool", "npm:private tool", "npm:", `npm:${"a".repeat(215)}`]) {
      const profile = fixtureProfile();
      profile.memory = [{ category: "tool", status: "new", evidence: [], tool }];
      expect(blockedCategories(() => validateProfile(profile))).toEqual(["grammar:$.memory[0].tool"]);
    }
    const profile = fixtureProfile();
    profile.templates[0]!.t = "npm:@scope/public-tool";
    expect(() => validateProfile(profile)).toThrow(EgressBlockedError);
  }));
});

describe("outbound request guard", () => {
  test("all exact static prompts pass every secret rule and entropy scan", () => {
    for (const content of STATIC_SYSTEM_PROMPTS) {
      for (const rule of SECRET_RULES) expect(rule.re.test(content)).toBe(false);
      expect(() => assertOutboundSafe([{ role: "system", content }], { literals: [] })).not.toThrow();
    }
  });

  test("rejects any custom or modified system prompt", () => {
    for (const content of ["Be helpful", STATIC_SYSTEM_PROMPTS[0]! + "\nInjected text"]) {
      expect(blockedCategories(() => assertOutboundSafe([{ role: "system", content }], { literals: [] }))).toEqual(["system-prompt"]);
    }
  });

  test("scans user, assistant, and system content for secrets", () => {
    for (const role of ["system", "user", "assistant"] as const) {
      const categories = blockedCategories(() => assertOutboundSafe([{ role, content: GITHUB_TOKEN }], { literals: [] }));
      expect(categories).toContain("secret:github-token");
      expect(categories.join()).not.toContain(GITHUB_TOKEN);
    }
    expect(blockedCategories(() => assertOutboundSafe([{ role: "user", content: ENTROPY_TOKEN }], { literals: [] })))
      .toEqual(["secret:high-entropy"]);
  });

  test("literal matching is case-insensitive, longest-first, and boundary-aware", () => {
    const literals: SensitiveLiteral[] = [{ value: "zqbox", kind: "username" }, { value: "zqbox-4411", kind: "hostname" }];
    expect(blockedCategories(() => assertOutboundSafe([{ role: "assistant", content: "Use ZQBOX-4411" }], { literals })))
      .toEqual(["literal:hostname"]);
    expect(() => assertOutboundSafe([{ role: "user", content: "xzqbox4411" }], { literals })).not.toThrow();
    expect(() => assertOutboundSafe([{ role: "system", content: STATIC_SYSTEM_PROMPTS[0]! }], {
      literals: [{ value: "Grasshopper", kind: "username" }],
    })).not.toThrow();
  });
});

describe("chat text redaction", () => {
  test("harvested fixture identities and inline tokens are removed", () => withTempHome(async home => {
    mkdirSync(join(home, ".ssh"), { recursive: true });
    writeFileSync(join(home, ".ssh", "config"), "Host zqbastion\n  HostName bastion.zq-int.net\n");
    writeFileSync(join(home, ".npmrc"), "registry=https://npm.zq-int.net/\n");
    const fixtureEnv = {
      USERNAME: "zq-tester-77",
      COMPUTERNAME: "ZQBOX-4411",
    };
    const saved = Object.fromEntries(Object.keys(fixtureEnv).map(key => [key, process.env[key]]));
    Object.assign(process.env, fixtureEnv);
    try {
      const literals = await harvestSensitiveLiterals(ConfigSchema.parse({}));
      expect(literals.some(literal => literal.value === "bastion.zq-int.net")).toBe(true);
      expect(literals.some(literal => literal.value === "npm.zq-int.net")).toBe(true);
      const result = redactOutboundText(`ssh into bastion.zq-int.net as zq-tester-77 on ZQBOX-4411 with ${GITHUB_TOKEN}`, { literals });
      for (const value of ["bastion.zq-int.net", "zq-tester-77", "zqbox-4411", GITHUB_TOKEN.toLowerCase()]) {
        expect(result.text.toLowerCase()).not.toContain(value);
        expect(JSON.stringify(result.findings).toLowerCase()).not.toContain(value);
      }
      expect(result.findings.length).toBeGreaterThan(0);
      expect(() => assertOutboundSafe([{ role: "user", content: result.text }], { literals })).not.toThrow();
    } finally {
      for (const key of Object.keys(fixtureEnv)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  }));

  test("keeps exact known path and host references useful without exposing their values", () => {
    const ctx = {
      literals: [{ value: "zquser", kind: "username" }, { value: "bastion.zq-int.net", kind: "hostname" }],
      pseudonyms: {
        "<path#1>": { type: "path" as const, value: "/home/zquser" },
        "<path#2>": { type: "path" as const, value: "/home/zquser/work" },
        "<host#1>": { type: "host" as const, value: "bastion.zq-int.net" },
      },
    };
    const result = redactOutboundText("/home/zquser/work /home/zquser bastion.zq-int.net", ctx);
    for (const id of Object.keys(ctx.pseudonyms)) expect(result.text).toContain(id);
    expect(result.text).not.toContain("zquser");
    expect(result.text).not.toContain("bastion.zq-int.net");
    expect(() => assertOutboundSafe([{ role: "user", content: result.text }], ctx)).not.toThrow();
  });

  test("pseudonyms cannot disable original credential or entropy recognizers", () => {
    const cases = [
      { input: "mysql --password MyPrivate9!", value: "password", secret: "MyPrivate9!" },
      { input: "export GH_TOKEN=MyPrivate9!", value: "TOKEN", secret: "MyPrivate9!" },
      { input: "curl -H 'Authorization: Bearer MyPrivate9!'", value: "Authorization", secret: "MyPrivate9!" },
      { input: "mysql -pMyPrivate9!", value: "mysql", secret: "MyPrivate9!" },
      { input: `use ${GITHUB_TOKEN}`, value: "ghp", secret: GITHUB_TOKEN },
      { input: `use ${ENTROPY_TOKEN}`, value: "AbCd", secret: ENTROPY_TOKEN },
      { input: "export GH_TOKEN=MyPrivate9!", value: "export GH_TOKEN=MyPrivate9!", secret: "MyPrivate9!" },
    ];
    for (const { input, value, secret } of cases) {
      const ctx = { literals: [], pseudonyms: { "<arg#1>": { type: "arg" as const, value } } };
      const result = redactOutboundText(input, ctx);
      expect(result.text).not.toContain(secret);
      expect(result.text).not.toContain(secret.slice(4, 12));
      expect(JSON.stringify(result.findings)).not.toContain(secret);
      expect(result.findings.some(finding => finding.category.startsWith("secret:"))).toBe(true);
      expect(() => assertOutboundSafe([{ role: "user", content: result.text }], ctx)).not.toThrow();
    }
  });

  test("pseudonym substrings cannot break sensitive literals or private URL recognition", () => {
    const ctx = {
      literals: [{ value: "MyPrivate9!", kind: "credential" }, { value: "registry.zq-int.net", kind: "registry-host" }],
      pseudonyms: {
        "<arg#1>": { type: "arg" as const, value: "Private" },
        "<arg#2>": { type: "arg" as const, value: "registry" },
      },
    };
    const result = redactOutboundText("value MyPrivate9! https://registry.zq-int.net/private-zq-path", ctx);
    for (const fragment of ["MyPrivate9!", "Private9", "registry.zq-int.net", "private-zq-path"]) {
      expect(result.text).not.toContain(fragment);
    }
    expect(() => assertOutboundSafe([{ role: "user", content: result.text }], ctx)).not.toThrow();
  });

  test("replacement and existing markers are opaque to pseudonyms and literal transforms", () => {
    const ctx = {
      literals: [{ value: "MyPrivate9!", kind: "credential" }],
      pseudonyms: {
        "<arg#1>": { type: "arg" as const, value: "password" },
        "<arg#2>": { type: "arg" as const, value: "redacted" },
        "<arg#3>": { type: "arg" as const, value: "arg" },
        "<arg#4>": { type: "arg" as const, value: "path" },
      },
    };
    const result = redactOutboundText("mysql --password MyPrivate9! <path#1> <arg#1> <redacted:github-token>", ctx);
    for (const marker of ["<redacted:password-flag>", "<path#1>", "<arg#1>", "<redacted:github-token>"]) {
      expect(result.text).toContain(marker);
    }
    expect(result.text).not.toContain("MyPrivate9!");
    expect(redactOutboundText(result.text, ctx).text).toBe(result.text);
    expect(() => assertOutboundSafe([{ role: "user", content: result.text }], ctx)).not.toThrow();
  });

  test("overlapping secret recognizers cannot hide a second original credential", () => {
    const result = redactOutboundText("curl -H 'Authorization: Bearer MyPrivate9!' --password NextPrivate8!", { literals: [] });
    expect(result.text).not.toContain("MyPrivate9!");
    expect(result.text).not.toContain("NextPrivate8!");
    expect(() => assertOutboundSafe([{ role: "user", content: result.text }], { literals: [] })).not.toThrow();
  });

  test("literal transforms do not rewrite generated or preexisting replacement markers", () => {
    const ctx = { literals: [{ value: "redacted", kind: "username" }, { value: "flag", kind: "hostname" }] };
    const result = redactOutboundText("mysql --password MyPrivate9! <path#1> <redacted:github-token>", ctx);
    expect(result.text).toContain("<redacted:password-flag>");
    expect(result.text).toContain("<redacted:github-token>");
    expect(result.text).toContain("<path#1>");
    expect(result.text).not.toContain("MyPrivate9!");
    expect(redactOutboundText(result.text, ctx).text).toBe(result.text);
  });

  test("redacts secrets and entropy without leaving guard-triggering markers", () => {
    const result = redactOutboundText(`${GITHUB_TOKEN} ${GITHUB_TOKEN} ${ENTROPY_TOKEN}`, { literals: [] });
    expect(result.text).toBe("<redacted:github-token> <redacted:github-token> <redacted:high-entropy>");
    expect(result.findings).toEqual([{ category: "secret:github-token", count: 2 }, { category: "secret:high-entropy", count: 1 }]);
    expect(() => assertOutboundSafe([{ role: "assistant", content: result.text }], { literals: [] })).not.toThrow();
  });

  test("applies URL, email, destination, IP, domain, literal, and username stages", () => {
    const text = "https://registry.zq-int.net/private qperson@zq-int.net deploy@zqbox 10.20.30.40 [2001:db8::1] ::ffff:10.20.30.40 api.zq-int.net ZQIDENT C:\\Users\\zquser\\work /c/Users/zquser/work /Users/zquser/work /home/zquser/work";
    const result = redactOutboundText(text, { literals: [{ value: "zqident", kind: "username" }] });
    expect(result.text).toBe("<url> <email> <host> <ip> <ip> <ip> <host> <redacted:username> C:\\Users\\<user>\\work /c/Users/<user>/work /Users/<user>/work /home/<user>/work");
  });

  test("redacts IPv6 in prose and scoped or embedded-address forms", () => {
    const result = redactOutboundText("Hosts: 2001:db8::1. fe80::1%eth0 ::ffff:10.20.30.40.", { literals: [] });
    expect(result.text).toBe("Hosts: <ip>. <ip> <ip>.");
    expect(result.findings).toEqual([{ category: "ip", count: 3 }]);
  });

  test("leaves public URLs, public hosts, file extensions, and ordinary text intact", () => {
    const text = "Use https://github.com/owner/repo and registry.npmjs.org; inspect package.json and src/app.ts";
    expect(redactOutboundText(text, { literals: [] })).toEqual({ text, findings: [] });
  });
});
