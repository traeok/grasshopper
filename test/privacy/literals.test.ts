import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ConfigSchema } from "../../src/core/config.ts";
import { toShellPath } from "../../src/core/paths.ts";
import { harvestSensitiveLiterals, literalRegex } from "../../src/privacy/literals.ts";
import { withTempHome } from "../helpers/env.ts";

// Failure diagnostics must never dump the harvested machine identity or credentials.
function expectLiteral(literals: { value: string; kind: string }[], expected: { value: string; kind: string }): void {
  expect(literals.some(item => item.value === expected.value && item.kind === expected.kind), `missing fixture ${expected.kind}`).toBe(true);
}

const fixtureEnv = {
  USERNAME: "zq-tester-77", USER: "zquser-88", LOGNAME: "zqlogin-99",
  COMPUTERNAME: "ZQBOX-4411", HOSTNAME: "zqhost-5511", USERDOMAIN: "ZQDOMAIN-6611",
  USERDNSDOMAIN: "zq-identity.internal", LOGONSERVER: "\\\\zqlogon-7711",
  GHOP_TEST_TOKEN: "zqEnvironmentSecret123", GHOP_TEST_PASS: "short",
  GHOP_TEST_REGISTRY: "https://zqenv-registry.internal/somewhere",
  HTTP_PROXY: "http://zqproxy.internal:8080", HTTPS_PROXY: "http://zqsecure-proxy.internal:8080",
  ALL_PROXY: "socks5://zqall-proxy.internal:1080", no_proxy: ".zqbypass.internal,zqplainproxy:8080,github.com",
};

// Git must not discover the real global config even when the calling environment overrides it.
function withLiteralHome(fn: (home: string) => Promise<void>): Promise<void> {
  return withTempHome(async home => {
    const overrides: Record<string, string> = {
      ...fixtureEnv,
      APPDATA: join(home, "AppData", "Roaming"),
      XDG_CONFIG_HOME: join(home, ".config"),
      GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_COUNT: "0",
    };
    const saved = Object.fromEntries(Object.keys(overrides).map(key => [key, process.env[key]]));
    Object.assign(process.env, overrides);
    try { await fn(home); } finally {
      for (const key of Object.keys(overrides)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    }
  });
}

function fixture(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
}

describe("harvestSensitiveLiterals", () => {
  test("collects home, identity, environment secrets, proxy hosts, URLs, and user extras", () => withLiteralHome(async home => {
    const config = ConfigSchema.parse({ privacy: { extraSensitiveLiterals: ["zqCustomLiteral-8811"] } });
    const literals = await harvestSensitiveLiterals(config);
    for (const [value, kind] of [
      [home, "home"], [toShellPath(home, "bash"), "home"],
      ["zq-tester-77", "username"], ["zquser-88", "username"], ["zqlogin-99", "username"],
      ["ZQBOX-4411", "hostname"], ["zqhost-5511", "hostname"], ["zqlogon-7711", "hostname"],
      ["ZQDOMAIN-6611", "domain"], ["zq-identity.internal", "domain"],
      ["zqEnvironmentSecret123", "env-secret"], ["zqenv-registry.internal", "registry-host"],
      ["zqproxy.internal", "proxy-host"], ["zqsecure-proxy.internal", "proxy-host"],
      ["zqall-proxy.internal", "proxy-host"], ["zqbypass.internal", "proxy-host"],
      ["zqplainproxy", "proxy-host"], ["zqCustomLiteral-8811", "user-defined"],
    ]) expectLiteral(literals, { value: value!, kind: kind! });
    expect(literals.some(item => item.value === "short")).toBe(false);
  }));

  test("reads SSH aliases, names, users, jumps, and unhashed known hosts", () => withLiteralHome(async home => {
    fixture(join(home, ".ssh", "config"), [
      "Host zqbastion zqsecond *.zqwild.internal !zqnegated",
      "  HostName bastion.zq-int.net", "  User zqsshuser", "  ProxyJump zqjumpuser@zqjump.internal:2222,zqnext.internal",
      "HostName=equals.zq-int.net # trailing comment", "# Host zqcomment",
    ].join("\n"));
    fixture(join(home, ".ssh", "known_hosts"), [
      "zqknown.internal,[zqport.internal]:2222 ssh-ed25519 fixture-key",
      "|1|zqhashed|zqhashvalue ssh-ed25519 fixture-key",
      "@cert-authority zqcert.internal ssh-ed25519 fixture-key",
      "# zqcomment.internal ignored",
    ].join("\n"));
    const literals = await harvestSensitiveLiterals(ConfigSchema.parse({}));
    for (const value of ["zqbastion", "zqsecond", "bastion.zq-int.net", "zqjump.internal", "zqnext.internal", "equals.zq-int.net", "zqknown.internal", "zqport.internal", "zqcert.internal"]) {
      expectLiteral(literals, { value, kind: "ssh-host" });
    }
    for (const value of ["zqsshuser", "zqjumpuser"]) expectLiteral(literals, { value, kind: "username" });
    for (const value of ["*.zqwild.internal", "!zqnegated", "zqcomment", "zqcomment.internal", "|1|zqhashed|zqhashvalue"]) {
      expect(literals.some(item => item.value === value)).toBe(false);
    }
  }));

  test("scans every supported home and APPDATA config location", () => withLiteralHome(async home => {
    const files = [
      ".npmrc", ".yarnrc", ".yarnrc.yml", ".config/pip/pip.conf", ".pip/pip.conf", ".pypirc",
      ".docker/config.json", ".kube/config", ".git-credentials", ".netrc", "_netrc", ".aws/config", ".aws/credentials",
      ".nuget/NuGet/NuGet.Config", ".m2/settings.xml", ".gradle/gradle.properties", ".cargo/config.toml", ".config/gh/hosts.yml",
      "AppData/Roaming/pip/pip.ini", "AppData/Roaming/NuGet/NuGet.Config",
    ];
    for (const [index, file] of files.entries()) {
      fixture(join(home, file), `registry=https://zqconfig-${index}.internal/path\npassword=zqConfigSecret-${index}\n`);
    }
    const literals = await harvestSensitiveLiterals(ConfigSchema.parse({}));
    for (const index of files.keys()) {
      expectLiteral(literals, { value: `zqconfig-${index}.internal`, kind: "registry-host" });
      expectLiteral(literals, { value: `zqConfigSecret-${index}`, kind: "credential" });
    }
  }));

  test("extracts credential fields, netrc, URL credentials, kube clusters, and plain FQDNs", () => withLiteralHome(async home => {
    fixture(join(home, ".npmrc"), '//zqnpm.internal/:_authToken=zqNpmCredential123\nregistry=https://github.com/\n');
    fixture(join(home, ".yarnrc.yml"), 'npmAuthToken: "zqYamlCredential123"\nregistryHost: zqplain.internal\n');
    fixture(join(home, ".docker/config.json"), '{"auths":{"zqdocker.internal":{"auth":"zqDockerCredential123"}}}');
    fixture(join(home, ".aws/credentials"), 'aws_access_key_id=zqAwsAccess123\naws_secret_access_key=zqAwsSecret123\naws_session_token=zqAwsSession123\n');
    fixture(join(home, ".netrc"), 'machine zqnetrc.internal login zqnetrcuser password "zqNetrcPassword123"\n');
    fixture(join(home, "_netrc"), 'machine zqnetrc2.internal login zqnetrcuser2 password zqNetrcPassword456\n');
    fixture(join(home, ".git-credentials"), 'https://zqurluser:zqEncoded%21Password@zqgit.internal/repo\n');
    fixture(join(home, ".kube", "config"), 'clusters:\n- name: zqcluster-123\n  cluster:\n    server: https://zqkube.internal:6443\n');
    const literals = await harvestSensitiveLiterals(ConfigSchema.parse({}));
    for (const value of ["zqNpmCredential123", "zqYamlCredential123", "zqDockerCredential123", "zqAwsAccess123", "zqAwsSecret123", "zqAwsSession123", "zqNetrcPassword123", "zqNetrcPassword456", "zqurluser", "zqEncoded%21Password", "zqEncoded!Password"]) {
      expectLiteral(literals, { value, kind: "credential" });
    }
    for (const value of ["zqnpm.internal", "zqplain.internal", "zqdocker.internal", "zqnetrc.internal", "zqnetrc2.internal", "zqgit.internal"]) {
      expectLiteral(literals, { value, kind: "registry-host" });
    }
    expectLiteral(literals, { value: "zqnetrcuser", kind: "username" });
    expectLiteral(literals, { value: "zqnetrcuser2", kind: "username" });
    expectLiteral(literals, { value: "zqcluster-123", kind: "cluster" });
    expectLiteral(literals, { value: "zqkube.internal", kind: "cluster" });
    expect(literals.some(item => item.value.toLowerCase() === "github.com")).toBe(false);
  }));

  test.skipIf(!Bun.which("git"))("reads only the fixture Git global config, with identity and URL hosts", () => withLiteralHome(async home => {
    fixture(join(home, ".gitconfig"), [
      '[user]', '  name = Zq Fixture Developer', '  email = zqfixture@zqgitdomain.internal',
      '[url "https://zqgitbase.internal/"]', '  insteadOf = zqshort:',
      '[url "git@zqgitscp:"]', '  insteadOf = zqscp:',
    ].join("\n"));
    const literals = await harvestSensitiveLiterals(ConfigSchema.parse({}));
    expectLiteral(literals, { value: "Zq Fixture Developer", kind: "git-identity" });
    expectLiteral(literals, { value: "zqfixture@zqgitdomain.internal", kind: "email" });
    expectLiteral(literals, { value: "zqgitdomain.internal", kind: "domain" });
    expectLiteral(literals, { value: "zqgitbase.internal", kind: "registry-host" });
    expectLiteral(literals, { value: "zqgitscp", kind: "registry-host" });
  }));

  test("filters safe values and small numbers, and deduplicates case-insensitively", () => withLiteralHome(async () => {
    const extras = ["abc", "docker", "environment", "GITHUB.COM", "12345", "123456", "zqallowed", "zqUnique-123", "ZQUNIQUE-123", "ZQ-TESTER-77"];
    const literals = await harvestSensitiveLiterals(ConfigSchema.parse({ privacy: { extraSensitiveLiterals: extras, allowWords: ["zqallowed"] } }));
    for (const value of extras.slice(0, 5).concat("zqallowed")) {
      expect(literals.some(item => item.value.toLowerCase() === value.toLowerCase())).toBe(false);
    }
    expectLiteral(literals, { value: "123456", kind: "user-defined" });
    expect(literals.filter(item => item.value.toLowerCase() === "zqunique-123")).toHaveLength(1);
    expect(literals.filter(item => item.value.toLowerCase() === "zq-tester-77")).toHaveLength(1);
  }));

  test("skips missing and unreadable files without losing other literals", () => withLiteralHome(async home => {
    mkdirSync(join(home, ".npmrc")); // Reading a directory as UTF-8 fails on supported platforms.
    const literals = await harvestSensitiveLiterals(ConfigSchema.parse({ privacy: { extraSensitiveLiterals: ["zqStillHarvested123"] } }));
    expectLiteral(literals, { value: "zqStillHarvested123", kind: "user-defined" });
  }));
});

describe("literalRegex", () => {
  test("returns null for no usable literals", () => {
    expect(literalRegex([])).toBeNull();
    expect(literalRegex([{ value: "", kind: "user-defined" }])).toBeNull();
  });

  test("escapes metacharacters, matches case-insensitively, and prefers the longest literal", () => {
    const re = literalRegex([
      { value: "zqservice", kind: "hostname" },
      { value: "zqservice.internal", kind: "hostname" },
      { value: "zq[a]+.corp", kind: "user-defined" },
      { value: "zq(a)$^|?*{}\\", kind: "user-defined" },
    ])!;
    expect(re.exec("ZQSERVICE.INTERNAL")?.[0]).toBe("ZQSERVICE.INTERNAL");
    expect(re.test("(ZQ[A]+.CORP)")).toBe(true);
    expect(re.test("zqaaaaXcorp")).toBe(false);
    expect(re.test("zq(a)$^|?*{}\\")).toBe(true);
    expect(re.global).toBe(false);
  });

  test("requires alphanumeric boundaries while allowing punctuation and underscores", () => {
    const re = literalRegex([{ value: "zqhost", kind: "hostname" }])!;
    for (const text of ["zqhost", "_zqhost_", "(zqhost)", "zqhost.internal", "ssh zqhost:22"]) expect(re.test(text)).toBe(true);
    for (const text of ["azqhost", "9zqhost", "zqhost0", "zqhosts"]) expect(re.test(text)).toBe(false);
  });
});
