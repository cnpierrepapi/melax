// Needs internet: two throwaway wallets on the public NWC sandbox (faucet.nwc.dev, fake sats).
import { NwcBackend } from "../src/index.ts";
import { runContract } from "./contract.ts";

let network = "";
runContract("NWC sandbox (faucet.nwc.dev)", async () => {
  const payee = await NwcBackend.fromFaucet(0);
  const payer = await NwcBackend.fromFaucet(50_000);
  network = (await payee.capabilities()).network;
  return { payee, payer, network, exactRefund: false };
});
