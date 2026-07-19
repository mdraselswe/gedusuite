import { spawnSync } from "node:child_process";

const commands = [
  ["npx", ["prisma", "generate"]],
  ["npx", ["next", "build", "--webpack"]],
];

for (const [command, args] of commands) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
