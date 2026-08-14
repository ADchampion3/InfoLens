process.stdout.write(JSON.stringify({
  bundled: process.env.INFOLENS_OPENCLI_BUNDLED === "1",
  args: process.argv.slice(2)
}));
