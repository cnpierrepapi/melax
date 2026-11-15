// Loaded into a gateway process by scripts/crash-demo.ts, and by nothing else. When MELAX_CRASH_ON is set,
// the first request whose URL contains it is sent for real, and the moment it has gone out and been
// answered, the process kills itself with SIGKILL: no exit handler, no cleanup, nothing written after.
// This is the worst moment there is for a payment: the mint has done its part and the gateway has not
// recorded it. Same idea as `fault()` in the integration tests, at the same place, the network edge.
const target = process.env.MELAX_CRASH_ON;
if (target) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url.includes(target)) {
      await realFetch(input, init);
      process.stderr.write(`[crash-preload] ${target} answered by the mint; killing this process now\n`);
      process.kill(process.pid, "SIGKILL");
      await new Promise(() => {});
    }
    return realFetch(input, init);
  };
}
