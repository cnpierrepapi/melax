// The five calls the simulator page makes to the gateway. All of them exist in demo mode only.
export interface Sms {
  id: number;
  kind: string;
  text: string;
  at: number;
}
export interface Person {
  name: string;
  /** Nine digits, as dialled inside Senegal. */
  phone: string;
  lang: string;
  /** An agent: turns francs into sats and back. The second phone can be one. */
  agent?: boolean;
}
export interface People {
  code: string;
  ussd: string;
  topUp: { on: boolean; capFcfa: number };
  people: Person[];
}
export interface BooksEntry {
  seq: number;
  at: number;
  kind: string;
  hash: string;
  lines: Array<{ account: string; sats: number }>;
}
export interface Books {
  entries: BooksEntry[];
  totals: { ledgerSat: number; ecashSat: number; match: boolean };
  mint: { name: string; keyset: string };
  rate: { xofPerBtc: number; source: string } | null;
}

async function getJson<T>(url: string): Promise<T> {
  const r = await fetch(url, { signal: AbortSignal.timeout(15_000), cache: "no-store" });
  if (!r.ok) throw new Error(String(r.status));
  return (await r.json()) as T;
}

/** One USSD step. `dial` opens a session; after that only `input` is sent. */
export async function ussd(a: { sessionId: string; phone: string; input: string; dial?: string }): Promise<{ message: string; continue: boolean }> {
  const r = await fetch("/ussd/sim", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(a), signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(String(r.status));
  return (await r.json()) as { message: string; continue: boolean };
}

export const people = (): Promise<People> => getJson<People>("/sim/people");
export const books = (): Promise<Books> => getJson<Books>("/sim/state");
export const inbox = async (phone: string): Promise<Sms[]> => (await getJson<{ messages: Sms[] }>(`/sim/sms?phone=${encodeURIComponent(phone)}`)).messages;

/** "ok": the money arrived. "pending": it is on its way and an SMS will follow. "fail": nothing happened. */
export async function topUp(phone: string, fcfa: number): Promise<"ok" | "pending" | "fail"> {
  try {
    const r = await fetch("/sim/fund", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ phone, fcfa }), signal: AbortSignal.timeout(45_000) });
    if (r.status === 200) return "ok";
    if (r.status === 202) return "pending";
    return "fail";
  } catch {
    return "fail";
  }
}
