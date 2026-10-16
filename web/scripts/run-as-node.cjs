// Started by start.sh as root (it has to read the root-only secrets file, F-071). Before any website code is
// loaded, the process gives up root for the node user of the image (uid and gid 1000), then starts the Next.js
// standalone server in the same process, with the environment start.sh exported.
if (typeof process.getuid === "function" && process.getuid() === 0) {
  process.setgroups([1000]);
  process.setgid(1000);
  process.setuid(1000);
  process.env.HOME = "/home/node";
  process.env.USER = "node";
}
if (process.getuid() === 0) throw new Error("run-as-node: still root");
// import() loads server.js whether the standalone build emits it as CommonJS or as an ES module.
import("./server.js").catch((err) => { console.error(err); process.exit(1); });
