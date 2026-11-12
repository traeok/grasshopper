import type { Command } from "commander";
import { getConfigValue, loadConfig, setConfigValue, unsetConfigValue } from "../core/config.ts";

export function register(program: Command): void {
  const command = program.command("config").description("Inspect and edit validated local configuration");
  command.action(() => { console.log(JSON.stringify(loadConfig(), null, 2)); });
  command.command("list").action(() => { console.log(JSON.stringify(loadConfig(), null, 2)); });
  command.command("get <key>").action((key: string) => { console.log(JSON.stringify(getConfigValue(key), null, 2)); });
  command.command("set <key> <value>").action((key: string, value: string) => {
    setConfigValue(key, value);
    console.log(`${key} = ${JSON.stringify(getConfigValue(key))}`);
  });
  command.command("unset <key>").action((key: string) => {
    unsetConfigValue(key);
    console.log(`${key} = ${JSON.stringify(getConfigValue(key))}`);
  });
}
