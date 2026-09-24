// Unit tests never touch the network (plan Task 1): the global fetch throws
// if anything calls it. Tests that exercise HTTP inject their own fetcher,
// which this guard does not affect.
globalThis.fetch = (() => {
  throw new Error("global fetch is disabled in tests; inject a fetcher instead");
}) as typeof fetch;
