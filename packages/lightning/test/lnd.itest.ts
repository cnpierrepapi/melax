// Needs the regtest stack (docker compose up) and `bash scripts/dev-creds.sh`.
import { resolve } from "node:path";
import { LndBackend } from "../src/index.ts";
import { runContract } from "./contract.ts";

const keys = resolve(import.meta.dirname, "../../../.keys");
const lnd = (name: string, port: number) =>
  LndBackend.fromFiles({ baseUrl: `https://localhost:${port}`, macaroonPath: `${keys}/lnd-${name}/admin.macaroon`, tlsCertPath: `${keys}/lnd-${name}/tls.cert` });

runContract("LND on regtest (gateway node paid by the world node)", async () => ({
  payee: lnd("gw", 18081),
  payer: lnd("world", 18082),
  network: "regtest",
  exactRefund: true,
}));
