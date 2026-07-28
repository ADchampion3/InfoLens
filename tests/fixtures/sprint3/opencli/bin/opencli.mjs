import { appendFile, readFile } from "node:fs/promises";

const command = process.argv.slice(2, 4).join(" ");
const state = JSON.parse(await readFile(process.env.INFOLENS_TEST_OPENCLI_STATE, "utf8"));
await appendFile(`${process.env.INFOLENS_TEST_OPENCLI_STATE}.calls`, `${JSON.stringify(process.argv.slice(2))}\n`);
const key = command === "hackernews top" ? "hn" : command === "github-trending repos" ? "github" : "unknown";
const mode = state[key] ?? "success";
if (mode === "exit") { process.stderr.write(`${key} source unavailable\n`); process.exit(7); }
if (mode === "malformed") { process.stdout.write(JSON.stringify([{ nope: true }])); process.exit(0); }
if (key === "hn") process.stdout.write(JSON.stringify(Array.from({ length: 15 }, (_, index) => ({ id: index + 1, rank: index + 1, title: `HN story ${index + 1}`, score: 300 - index, author: `author${index}`, ...(index === 14 ? {} : { comments: 50 - index }), url: `https://example.com/${index + 1}` }))));
else if (key === "github") process.stdout.write(JSON.stringify(Array.from({ length: 12 }, (_, index) => ({ rank: index + 1, repo: `owner${index}/repo${index}`, description: index === 0 ? "A deliberately long repository description used to exercise compact workspace wrapping without changing row ownership." : `Repository ${index}`, language: index === 11 ? null : ["TypeScript", "Python", "Rust", "Go"][index % 4], stars: 1000 + index, forks: 100 + index, starsSince: 50 - index, url: `https://github.com/owner${index}/repo${index}` }))));
else { process.stderr.write("unexpected command\n"); process.exit(8); }
