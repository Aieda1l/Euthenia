import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { collect, parseCollectArgs, terminalSafe } from "../src/source/collect.js";

// Thin CLI: npm run source:collect -- --postal-code 98105 [--validations <file>] [--report <file>]
// Exit codes: 0 PASS, 1 BLOCKED, 2 source/schema/usage error, 3 deferred by Retry-After.
// H9: messages can carry source text, so every printed line escapes control characters.

const args = parseCollectArgs(process.argv.slice(2));
if (!args.ok) {
  // The usage text's own line breaks are kept; each line is escaped.
  console.error(args.message.split("\n").map(terminalSafe).join("\n"));
  process.exitCode = 2;
} else {
  const dataDir = fileURLToPath(new URL("../data/", import.meta.url));
  try {
    const result = await collect({
      postalCode: args.postalCode,
      dataDir,
      validationsPath: args.validationsPath === null ? null : resolve(args.validationsPath),
      reportPath: args.reportPath === null ? null : resolve(args.reportPath),
    });
    const write = result.exitCode === 0 ? console.log : console.error;
    const print = (line: string) => write(terminalSafe(line));
    print(`${result.status}: ${result.message}`);
    if (result.nextPermittedAt !== null) print(`Next permitted request: ${result.nextPermittedAt}`);
    print(`Audit: ${result.auditDir}`);
    if (result.reportWritten && args.reportPath !== null) print(`Report: ${resolve(args.reportPath)}`);
    // A failed audit or report write is shown, but the decided status and exit code stand.
    for (const problem of result.writeErrors) console.error(terminalSafe(`WARNING: ${problem}`));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(terminalSafe(`ERROR: ${error instanceof Error ? error.message : String(error)}`));
    process.exitCode = 2;
  }
}
