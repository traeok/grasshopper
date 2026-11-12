import { expect, test } from "bun:test";
import { splitCommands, tokenize } from "../../src/history/tokenize.ts";
import type { Word } from "../../src/history/tokenize.ts";

test("quotes preserve raw spelling and concatenate into a single word", () => {
  expect(tokenize(`echo pre'one two'"three" ''`)).toEqual([
    { kind: "word", raw: "echo", value: "echo", quoted: false, expansion: false },
    { kind: "word", raw: `pre'one two'"three"`, value: "preone twothree", quoted: true, expansion: false },
    { kind: "word", raw: "''", value: "", quoted: true, expansion: false },
  ]);
});

test("single quotes are literal; double quotes recognize only shell escapes", () => {
  const words = tokenize("echo '$HOME $(id) \\q' \"a\\\"b\\\\c\\$d\\`e\\q\"") as Word[];
  expect(words[1]?.value).toBe("$HOME $(id) \\q");
  expect(words[1]?.expansion).toBe(false);
  expect(words[2]?.value).toBe('a"b\\c$d`e\\q');
  expect(words[2]?.expansion).toBe(false);
  expect(tokenize('echo "<(literal)"')[1]).toMatchObject({ value: "<(literal)", expansion: false });
});

test("ANSI-C quotes decode escapes without interpreting expansions", () => {
  const words = tokenize(String.raw`printf $'one\ntwo\t\x41\101\u2014\'\$HOME'`) as Word[];
  expect(words[1]?.value).toBe("one\ntwo\tAA—'\\$HOME");
  expect(words[1]?.quoted).toBe(true);
  expect(words[1]?.expansion).toBe(false);
});

test("outside escapes protect whitespace, operators and comment characters", () => {
  const tokens = tokenize("echo a\\ b \\| \\# kept\\\nword");
  expect(tokens.map(token => token.value)).toEqual(["echo", "a b", "|", "#", "keptword"]);
  expect(tokens[1]).toMatchObject({ raw: "a\\ b", quoted: false, expansion: false });
});

test("nested expansions stay atomic and are marked without execution", () => {
  const forms = [
    '$(printf "%s" "$(echo nested)")',
    '${NAME:-${OTHER:-$(echo fallback)}}',
    '<(cat <(printf data))',
    '>(cat "a)b")',
    '`echo $(printf x)`',
    '$((1 + (2 * 3)))',
  ];
  for (const form of forms) {
    expect(tokenize(`echo prefix${form}suffix`)[1]).toEqual({
      kind: "word", raw: `prefix${form}suffix`, value: `prefix${form}suffix`, quoted: false, expansion: true,
    });
  }
  expect(tokenize('echo "$(echo one | cat) ${HOME}"')[1]).toMatchObject({
    value: "$(echo one | cat) ${HOME}", quoted: true, expansion: true,
  });
  expect(tokenize("echo $HOME $1").slice(1)).toMatchObject([{ expansion: true }, { expansion: true }]);
});

test("comments start only at a word boundary outside quotes", () => {
  expect(tokenize('echo a#b "#literal" # ignored | danger\necho next').map(token => token.value))
    .toEqual(["echo", "a#b", "#literal", "echo", "next"]);
  expect(tokenize("# nothing here")).toEqual([]);
});

test("operators use longest matches including arbitrary file descriptors", () => {
  const ops = ["||", "&&", ";;", "|&", "|", "&", ";", "(", ")", "&>>", "&>", "2>&1", ">&2", "2>>", "2>", ">>", ">", "<<<", "<<", "<", "12>", "42>&17", "<<-"];
  for (const op of ops) expect(tokenize(op)).toEqual([{ kind: "op", value: op }]);
  expect(tokenize("echo abc2>out").map(token => token.value)).toEqual(["echo", "abc2", ">", "out"]);
  expect(tokenize("echo 2>out").map(token => token.value)).toEqual(["echo", "2>", "out"]);
});

test("splitCommands separates assignments, words, redirects and pipelines", () => {
  const commands = splitCommands(tokenize('FOO=one BAR="two three" >out git status 2>>err 2>&1 | grep x && echo done'));
  expect(commands.map(command => ({
    assigns: command.assigns.map(word => word.value),
    words: command.words.map(word => word.value),
    redirects: command.redirects.map(redirect => ({ op: redirect.op, target: redirect.target?.value })),
    sep: command.sep,
  }))).toEqual([
    { assigns: ["FOO=one", "BAR=two three"], words: ["git", "status"], redirects: [{ op: ">", target: "out" }, { op: "2>>", target: "err" }, { op: "2>&1", target: undefined }], sep: "|" },
    { assigns: [], words: ["grep", "x"], redirects: [], sep: "&&" },
    { assigns: [], words: ["echo", "done"], redirects: [], sep: null },
  ]);
  expect(splitCommands(tokenize("echo NAME=value"))[0]?.assigns).toEqual([]);
  expect(splitCommands(tokenize("ONLY=value"))[0]?.assigns[0]?.value).toBe("ONLY=value");
});

test("fd duplication never consumes a following command argument", () => {
  const command = splitCommands(tokenize("echo 12>&3 hello >&2 world >"))[0];
  expect(command?.words.map(word => word.value)).toEqual(["echo", "hello", "world"]);
  expect(command?.redirects).toEqual([{ op: "12>&3" }, { op: ">&2" }, { op: ">" }]);
});

test("subshell parentheses split commands but expansion parentheses do not", () => {
  const commands = splitCommands(tokenize("(echo one; echo $(printf two)) || (echo three)"));
  expect(commands.map(command => command.words.map(word => word.value))).toEqual([
    ["echo", "one"], ["echo", "$(printf two)"], ["echo", "three"],
  ]);
  expect(commands.map(command => command.sep)).toEqual([";", ")", ")"]);
  for (const sep of ["|", "||", "&&", ";", "&", "|&", ";;"]) {
    expect(splitCommands(tokenize(`a ${sep} b`)).map(command => command.sep)).toEqual([sep, null]);
  }
});

test("heredoc delimiters are targets and all body lines are ignored", () => {
  for (const op of ["<<", "<<-"]) {
    const commands = splitCommands(tokenize(`cat ${op}'END' | grep ok\necho malicious >file\nEND\necho later`));
    expect(commands).toHaveLength(2);
    expect(commands[0]?.redirects[0]).toMatchObject({ op, target: { value: "END", quoted: true } });
    expect(commands[1]?.words.map(word => word.value)).toEqual(["grep", "ok"]);
  }
  expect(splitCommands(tokenize("cat <<END \\\n| grep ok\nbody\nEND"))).toHaveLength(2);
  expect(tokenize("echo '<<END'\necho still-here").map(token => token.value)).toEqual(["echo", "<<END", "echo", "still-here"]);
  expect(tokenize('cat <<<data\necho next').map(token => token.value)).toEqual(["cat", "<<<", "data", "echo", "next"]);
});

test("unterminated quotes and expansions swallow the remainder without throwing", () => {
  for (const tail of ["'one | two", '"one | two', "$'one | two", "$(one | two", "${one | two", "<(one | two", "`one | two"]) {
    const tokens = tokenize(`echo ${tail}`);
    expect(tokens).toHaveLength(2);
    expect(tokens[1]).toMatchObject({ kind: "word", raw: tail });
    expect(splitCommands(tokens)).toHaveLength(1);
  }
  expect(tokenize("echo trailing\\")[1]?.value).toBe("trailing\\");
  expect(tokenize('echo "trailing\\')[1]?.value).toBe("trailing\\");
  expect(tokenize(" \t\r\n")).toEqual([]);
});

test("PowerShell preserves Windows backslashes and native quote escapes", () => {
  const words = tokenize("Get-Item C:\\Users\\Jane\\file.txt 'C:\\Jane''s Files\\a.txt' \"C:\\Temp\\a`\"b.txt\"", "powershell") as Word[];
  expect(words.map(word => word.value)).toEqual(["Get-Item", "C:\\Users\\Jane\\file.txt", "C:\\Jane's Files\\a.txt", 'C:\\Temp\\a"b.txt']);
  expect(words.slice(1).map(word => word.expansion)).toEqual([false, false, false]);
  expect(tokenize("Write-Output a` b `| `# `` `\nnext", "powershell").map(token => token.value))
    .toEqual(["Write-Output", "a b", "|", "#", "`", "next"]);
});

test("PowerShell expressions and here-strings stay opaque rather than becoming commands", () => {
  const tokens = tokenize('Write-Output "$env:HOME" "`$literal" \'$literal\' "$($private | Select-Object \'Name\')" @{ Authorization = \'private\'; nested = @(1, 2) }', "powershell") as Word[];
  expect(tokens).toHaveLength(6);
  expect(tokens.slice(1).map(word => word.expansion)).toEqual([true, false, false, true, true]);
  expect(tokens[4]?.value).toBe("$($private | Select-Object 'Name')");
  const here = tokenize('Write-Output @\'\nprivate | body\n\'@\nGet-Item C:\\Temp', "powershell");
  expect(here[1]).toMatchObject({ value: "private | body", quoted: true, expansion: false });
  expect(splitCommands(here).map(command => command.words[0]?.value)).toEqual(["Write-Output", "Get-Item"]);
});

test("PowerShell comments and statement separators cannot turn data into command words", () => {
  const commands = splitCommands(tokenize('Get-Item a#b <# private | ignored #>; # ignored\nGet-Process | Select-Object -First 1', "powershell"));
  expect(commands.map(command => command.words.map(word => word.value))).toEqual([
    ["Get-Item", "a#b"], ["Get-Process"], ["Select-Object", "-First", "1"],
  ]);
  expect(tokenize('Write-Output "$(Get-Item \'unterminated | data)', "powershell")).toHaveLength(2);
});

test("PowerShell all-stream redirection does not consume the next argument", () => {
  const command = splitCommands(tokenize("Write-Output *>&1 private", "powershell"))[0];
  expect(command?.words.map(word => word.value)).toEqual(["Write-Output", "private"]);
  expect(command?.redirects).toEqual([{ op: "*>&1" }]);
});
