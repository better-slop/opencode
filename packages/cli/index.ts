import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import type { ArgumentsCamelCase } from "yargs";
import {
  applyInstallPlans,
  listEmbeddedItems,
  planInstalls,
  resolveConfigRoot,
  resolveRegistryTree,
} from "@better-slop/core/registry";

type GlobalOpts = {
  cwd: string;
};

type AddOpts = GlobalOpts & {
  spec: string[];
  overwrite: boolean;
  "allow-postinstall": boolean;
};

type Plan = ReturnType<typeof planInstalls>[number];

function printHooks(plans: Plan[]): void {
  const with_hooks = plans.filter(
    (p) => p.postinstall && p.postinstall.commands.length > 0,
  );
  if (with_hooks.length === 0) return;

  console.log("\nPostinstall hooks detected (skipped unless --allow-postinstall):");
  for (const p of with_hooks) {
    console.log(`- ${p.item.kind}/${p.item.name}`);
    for (const cmd of p.postinstall?.commands ?? []) {
      console.log(`  - ${cmd}`);
    }
  }
}

async function runAdd(argv: ArgumentsCamelCase<AddOpts>): Promise<void> {
  const root = await resolveConfigRoot(argv.cwd);
  const resolved = await resolveRegistryTree(argv.spec, { cwd: argv.cwd });
  const plans = planInstalls(resolved, root);

  const files = plans.reduce((sum, p) => sum + p.writes.length, 0);
  const hooks = plans.some(
    (p) => p.postinstall && p.postinstall.commands.length > 0,
  );

  console.log(`Config: ${root.configPath}`);
  console.log(`Install root: ${root.opencodeDir} (${root.kind})`);
  console.log(
    `Files: ${files}  Overwrite: ${argv.overwrite ? "yes" : "no"}  Postinstall: ${argv.allowPostinstall ? "run" : "skip"}`,
  );

  console.log("Items:");
  for (const p of plans) {
    console.log(`- ${p.item.kind}/${p.item.name} (${p.item.source})`);
  }

  printHooks(plans);
  if (hooks && !argv.allowPostinstall) {
    console.log("\nRe-run with --allow-postinstall to execute hooks.");
  }

  const result = await applyInstallPlans(plans, {
    overwrite: argv.overwrite,
    allowPostinstall: argv.allowPostinstall,
  });

  console.log(`\nWrote ${result.wroteFiles.length} item(s).`);
  console.log(`Updated config: ${result.editedConfigPath}`);
  console.log(`Postinstall: ${result.ranPostinstall ? "ran" : "skipped"}`);
}

function runList(): void {
  console.log("Embedded items:");
  for (const name of listEmbeddedItems()) {
    console.log(`- ${name}`);
  }
}

const cli = yargs(hideBin(process.argv))
  .scriptName("ocx")
  .usage("$0 <command> [options]")
  .option("cwd", {
    type: "string",
    default: process.cwd(),
    global: true,
    describe: "Working directory",
  })
  .command<AddOpts>({
    command: "add <spec..>",
    describe: "Add specs (embedded names, URLs, or paths to .json manifests)",
    builder: (y) =>
      y
        .positional("spec", {
          describe: "Spec strings to add",
          type: "string",
          array: true,
          demandOption: true,
        })
        .option("overwrite", {
          type: "boolean",
          default: false,
          describe: "Overwrite existing files",
        })
        .option("allow-postinstall", {
          type: "boolean",
          default: false,
          describe: "Run postinstall hooks",
        }),
    handler: async (argv) => {
      await runAdd(argv);
    },
  })
  .command({
    command: "list",
    describe: "List available embedded items",
    handler: () => {
      runList();
    },
  })
  .demandCommand(1, "You must specify a command")
  .strict()
  .strictCommands()
  .recommendCommands()
  .help()
  .alias("h", "help")
  .version(false) // no version flag for now
  .showHelpOnFail(true)
  .wrap(Math.min(100, process.stdout.columns ?? 80))
  .epilogue(`Notes:
  - Specs can be embedded item names (e.g. "hello"), URLs, or paths to .json manifests.
  - Default install is project-local via nearest .opencode/opencode.jsonc.
  - Postinstall hooks are skipped unless --allow-postinstall is set.
  - // TODO: windows support
  - // TODO: decide bun add defaults`)
  .fail((msg, err) => {
    if (err) {
      console.error(err.message);
    } else if (msg) {
      console.error(msg);
    }
    process.exitCode = 1;
  });

try {
  await cli.parseAsync();
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exitCode = 1;
}
