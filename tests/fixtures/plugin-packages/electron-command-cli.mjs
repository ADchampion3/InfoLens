const args = process.argv.slice(process.versions.electron ? 1 : 2);
if (args[0] !== "fixture") {
  process.stderr.write(`unknown command '${args[0]}'\n`);
  process.exit(2);
}
process.stdout.write(JSON.stringify({ args }));
