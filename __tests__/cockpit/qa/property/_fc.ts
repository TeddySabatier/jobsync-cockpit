// Shared fast-check parameters (QA lane L8). Fixed seed => reproducible CI.
//   QA_FC_SEED  seed (default 20261104)
//   QA_FC_RUNS  numRuns for the pure properties (default 200; 10000 locally)
//   QA_FC_DB_RUNS numRuns for the SQLite state machine (default 25)
export const SEED = Number(process.env.QA_FC_SEED ?? 20261104);
export const RUNS = Number(process.env.QA_FC_RUNS ?? 200);
export const DB_RUNS = Number(process.env.QA_FC_DB_RUNS ?? 25);

export const fcParams = (numRuns: number = RUNS) => ({ seed: SEED, numRuns });
export const tag = (name: string) => `${name} [seed ${SEED}]`;

// Property runs scale with QA_FC_RUNS; the default 5 s test timeout does not.
vi.setConfig({ testTimeout: RUNS > 1000 ? 3_600_000 : 60_000 });
