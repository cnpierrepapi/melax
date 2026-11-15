// The simulator page: two phones that dial the real gateway, the SMS each one gets, a four-step guide
// and a view of the books.
// The guide never takes the visitor's word for anything. A step is ticked when the gateway's own SMS
// outbox shows it happened: a welcome message means the account exists, a deposit message means the
// money arrived, a "sent" message means the payment went through, and a "received" message on the
// other phone means it landed. The next step opens only then.
import { type Books, type People, type Person, type Sms, books, inbox, people, topUp } from "./api.ts";
import { type CopyKey, type Lang, copy, say } from "./copy.ts";
import { mountLang, paint } from "./lang.ts";
import { type Phone, createPhone } from "./phone.ts";

const ME = "melax.me";
const TOP_UP_FCFA = 5000;
const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const group = (n: number): string => String(Math.trunc(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
const spaced = (nine: string): string => `${nine.slice(0, 2)} ${nine.slice(2, 5)} ${nine.slice(5, 7)} ${nine.slice(7)}`;

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text = ""): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
}

let lang: Lang = "en";
let info: People | null = null;
/** The visitor's phone: a fresh number, or a seeded person when they took the shortcut. */
let me = { phone: "", ready: "" };
let other: Person | null = null;
let smsA: Sms[] = [];
let smsB: Sms[] = [];
/** Messages older than this on phone A were there before the guide started (a seeded account has history). */
let baseA = 0;
let lookedAtB = false;
let funding: "idle" | "wait" | "fail" = "idle";
let phoneA: Phone;
let phoneB: Phone;
let ledger: Books | null = null;

// ---------- who holds which phone ----------

function freshNumber(taken: string[]): string {
  for (;;) {
    const n = "7" + "05678"[Math.floor(Math.random() * 5)] + String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0");
    if (!taken.includes(n)) return n;
  }
}

function loadMe(): void {
  try {
    const kept = JSON.parse(localStorage.getItem(ME) ?? "null") as { phone?: unknown; ready?: unknown } | null;
    if (kept && typeof kept.phone === "string" && /^7[05678]\d{7}$/.test(kept.phone)) {
      const ready = typeof kept.ready === "string" && info?.people.some((p) => p.name === kept.ready && p.phone === kept.phone) ? kept.ready : "";
      me = { phone: kept.phone, ready };
      if (ready || !info?.people.some((p) => p.phone === kept.phone)) return;
    }
  } catch {
    /* nothing kept */
  }
  me = { phone: freshNumber(info?.people.map((p) => p.phone) ?? []), ready: "" };
}

function keepMe(): void {
  try {
    localStorage.setItem(ME, JSON.stringify(me));
  } catch {
    /* storage can be off */
  }
}

function pickOther(name?: string): void {
  const list = (info?.people ?? []).filter((p) => p.phone !== me.phone);
  other = list.find((p) => p.name === name) ?? list.find((p) => p.name === "Moussa") ?? list[0] ?? null;
}

async function holdPhones(): Promise<void> {
  phoneA.setOwner(me.phone);
  phoneB.setOwner(other?.phone ?? "");
  smsA = [];
  smsB = [];
  primed = false;
  lookedAtB = false;
  funding = "idle";
  // What a seeded account already holds is history, not progress in the guide.
  baseA = me.ready ? Math.max(0, ...(await inbox(me.phone).catch(() => [] as Sms[])).map((m) => m.id)) : 0;
  renderAll();
  await poll();
}

// ---------- the guide ----------

function progress(): { step: number; sentId: number } {
  const has = (kind: string) => smsA.some((m) => m.kind === kind && m.id > baseA);
  const opened = me.ready !== "" || smsA.some((m) => m.kind === "welcome");
  if (!opened) return { step: 1, sentId: 0 };
  const funded = me.ready !== "" || has("deposit") || has("received");
  if (!funded) return { step: 2, sentId: 0 };
  const sent = smsA.find((m) => m.kind === "sent" && m.id > baseA);
  if (!sent) return { step: 3, sentId: 0 };
  const landed = smsB.some((m) => m.kind === "received" && m.id > sent.id);
  return { step: landed && lookedAtB ? 5 : 4, sentId: sent.id };
}

/**
 * On a small screen the guide scrolls away while the visitor is on the keypad. This one line stays at
 * the bottom: which step, what to do, and the number to type when the step needs one.
 */
let guideInView = true;
function renderHint(step: number, vars: { name: string; number: string; code: string }): void {
  const hint = $("hint");
  const titles: CopyKey[] = ["g1.t", "g2.t", "g3.t", "g4.t", "done.t"];
  hint.replaceChildren(h("b", "hint-n", step <= 4 ? `${step}/4` : "4/4"), h("span", "hint-t", say(lang, titles[step - 1] ?? "done.t", vars)));
  if (step === 3) hint.append(h("code", "hint-num", vars.number));
  hint.hidden = guideInView || step > 4;
  hint.dataset.step = String(step);
}

/** Redraw the guide only when what it shows has changed: a button that is replaced mid-tap loses the tap. */
let drawn = "";
function renderGuide(): void {
  const box = $("guide");
  const { step } = progress();
  const name = other?.name ?? "";
  const vars = { name, number: other ? spaced(other.phone) : "", code: info?.code ?? "" };
  const signature = [step, lang, funding, lookedAtB, me.phone, me.ready, name, info?.topUp.on, other?.agent === true, other?.agent ? agentProgress() : 0].join("|");
  if (signature === drawn) return;
  drawn = signature;
  box.dataset.step = String(step);
  box.replaceChildren();
  renderHint(step, vars);

  // With an agent on the second phone, the agent's two steps are the only thing to do: the four steps
  // fold away, so two "do this now" steps never compete. Picking anyone else brings them back.
  if (other?.agent) {
    $("hint").hidden = true;
    box.append(agentBox(step)!, h("p", "agent-back", say(lang, "ag.back")));
    box.append(guideFoot(step));
    return;
  }

  const head = h("p", "guide-count", step <= 4 ? say(lang, "guide.step", { n: step }) : say(lang, "guide.done"));
  const dots = h("span", "guide-dots");
  for (let i = 1; i <= 4; i++) dots.append(h("i", i < step ? "dot done" : i === step ? "dot now" : "dot"));
  head.append(dots);
  box.append(head);

  const list = h("ol", "guide-list");
  const steps: Array<{ t: CopyKey; d: CopyKey; tip?: CopyKey; ok: CopyKey }> = [
    { t: "g1.t", d: "g1.d", tip: "g1.tip", ok: "g1.ok" },
    { t: "g2.t", d: "g2.d", ok: "g2.ok" },
    { t: "g3.t", d: "g3.d", tip: "g3.tip", ok: "g3.ok" },
    { t: "g4.t", d: "g4.d", ok: "done.t" },
  ];
  steps.forEach((s, i) => {
    const n = i + 1;
    const li = h("li", n < step ? "step done" : n === step ? "step now" : "step later");
    li.dataset.testid = `step-${n}`;
    li.append(h("h2", "step-title", say(lang, s.t, vars)));
    if (n < step) {
      const skipped = me.ready !== "" && n <= 2;
      li.append(h("p", "step-ok", skipped ? say(lang, "skip.note", { name: me.ready, code: vars.code }) : say(lang, s.ok, vars)));
    }
    if (n === step) {
      li.append(h("p", "step-how", say(lang, s.d, vars)));
      if (s.tip) li.append(h("p", "step-tip", say(lang, s.tip, vars)));
      if (n === 2) li.append(fundButton());
      if (n === 4 && !lookedAtB) {
        const b = h("button", "btn btn-go", say(lang, "g4.btn", vars));
        b.type = "button";
        b.dataset.testid = "show-b";
        b.addEventListener("click", () => show("b"));
        li.append(b);
      }
    }
    list.append(li);
  });
  box.append(list);

  if (step === 5) {
    const end = h("div", "guide-end");
    end.dataset.testid = "guide-end";
    end.append(h("h2", "end-title", say(lang, "done.t")), h("p", "end-how", say(lang, "done.d")));
    box.append(end);
  }
  const withAgent = agentBox(step);
  if (withAgent) box.append(withAgent);
  box.append(guideFoot(step));
}

/** The line under the guide: take a ready account (early on), or start again with a new number. */
function guideFoot(step: number): HTMLElement {
  const foot = h("p", "guide-foot");
  if (me.ready === "" && step <= 2 && (info?.people.length ?? 0) > 1) {
    const skip = h("button", "link", say(lang, "skip.btn"));
    skip.type = "button";
    skip.dataset.testid = "skip";
    skip.addEventListener("click", () => {
      const awa = info?.people.find((p) => p.name === "Awa") ?? info?.people[0];
      if (!awa) return;
      me = { phone: awa.phone, ready: awa.name };
      keepMe();
      pickOther(other?.name);
      void holdPhones();
    });
    foot.append(skip);
  } else {
    const again = h("button", "link", say(lang, "restart.btn"));
    again.type = "button";
    again.dataset.testid = "restart";
    again.addEventListener("click", () => {
      me = { phone: freshNumber(info?.people.map((p) => p.phone) ?? []), ready: "" };
      keepMe();
      pickOther(other?.name);
      show("a");
      void holdPhones();
    });
    foot.append(again);
  }
  return foot;
}

// ---------- a cash-in with an agent ----------

/**
 * Where the agent walk-through stands, from the SMS on the visitor's phone only: a "dep_user" message
 * means the agent's sats are held and the visitor was told where to pay; a "cashin" message after it
 * means the agent confirmed and the sats arrived. Messages from before the agent phone was picked
 * do not count.
 */
let agentBase = 0;
function agentProgress(): 1 | 2 | 3 {
  const held = smsA.find((m) => m.kind === "dep_user" && m.id > agentBase);
  if (!held) return 1;
  return smsA.some((m) => m.kind === "cashin" && m.id > held.id) ? 3 : 2;
}

function handPhoneB(name: string): void {
  pickOther(name);
  agentBase = Math.max(0, ...smsA.map((m) => m.id));
  phoneB.setOwner(other?.phone ?? "");
  smsB = [];
  primed = false;
  renderAll();
  void poll();
}

/** Shown when the second phone is an agent; once the first guide is done, an offer to pick one. */
function agentBox(step: number): HTMLElement | null {
  const agent = info?.people.find((p) => p.agent && p.phone !== me.phone);
  if (!other?.agent) {
    if (step < 5 || !agent) return null;
    const offer = h("div", "agent-offer");
    const b = h("button", "btn btn-go", say(lang, "ag.btn", { name: agent.name }));
    b.type = "button";
    b.dataset.testid = "use-agent";
    b.addEventListener("click", () => handPhoneB(agent.name));
    offer.append(h("h2", "agent-title", say(lang, "ag.title")), b);
    return offer;
  }
  const vars = { name: other.name, code: info?.code ?? "" };
  const at = agentProgress();
  const wrap = h("section", "agent");
  wrap.dataset.testid = "agent-guide";
  wrap.dataset.step = String(at);
  wrap.append(h("h2", "agent-title", say(lang, "ag.title")), h("p", "agent-intro", say(lang, "ag.intro", vars)));
  const list = h("ol", "agent-list");
  const steps: Array<{ t: CopyKey; d: CopyKey; ok: CopyKey }> = [
    { t: "ag1.t", d: "ag1.d", ok: "ag1.ok" },
    { t: "ag2.t", d: "ag2.d", ok: "ag.done" },
  ];
  steps.forEach((s, i) => {
    const n = i + 1;
    const li = h("li", n < at ? "step done" : n === at ? "step now" : "step later");
    li.dataset.testid = `agent-step-${n}`;
    li.append(h("h3", "step-title", say(lang, s.t, vars)));
    if (n < at) li.append(h("p", "step-ok", say(lang, s.ok, vars)));
    if (n === at) {
      li.append(h("p", "step-how", say(lang, s.d, vars)));
      if (n === 2) {
        const b = h("button", "btn btn-go", say(lang, "ag2.show", vars));
        b.type = "button";
        b.addEventListener("click", () => show("b"));
        li.append(b);
      }
    }
    list.append(li);
  });
  wrap.append(list);
  return wrap;
}

function fundButton(): HTMLElement {
  const wrap = h("div", "fund");
  if (!info?.topUp.on) {
    wrap.append(h("p", "step-tip", say(lang, "g2.off")));
    return wrap;
  }
  const b = h("button", "btn btn-go", say(lang, funding === "wait" ? "g2.wait" : "g2.btn"));
  b.type = "button";
  b.dataset.testid = "fund";
  b.disabled = funding === "wait";
  b.addEventListener("click", () => {
    funding = "wait";
    renderGuide();
    void topUp(me.phone, TOP_UP_FCFA).then((r) => {
      // "pending" means the sats are in and the SMS will follow: keep waiting for it.
      funding = r === "fail" ? "fail" : "wait";
      renderGuide();
      void poll();
    });
  });
  wrap.append(b);
  if (funding === "fail") wrap.append(h("p", "step-bad", say(lang, "g2.fail")));
  return wrap;
}

// ---------- phones, SMS, books ----------

function show(which: "a" | "b"): void {
  $("stage").dataset.show = which;
  $("tab-a").setAttribute("aria-selected", String(which === "a"));
  $("tab-b").setAttribute("aria-selected", String(which === "b"));
  if (which === "b" && !lookedAtB) {
    lookedAtB = true;
    renderGuide();
  }
}

function renderLabels(): void {
  const mine = me.ready ? say(lang, "phone.of", { name: me.ready }) : say(lang, "phone.you");
  const theirs = other ? say(lang, other.agent ? "phone.agent" : "phone.of", { name: other.name }) : "";
  $("tab-a").textContent = mine;
  $("tab-b").textContent = theirs;
  $("label-a").textContent = mine;
  $("num-a").textContent = spaced(me.phone);
  $("num-b").textContent = other ? spaced(other.phone) : "";
  const pick = $<HTMLSelectElement>("pick-b");
  pick.replaceChildren();
  for (const p of info?.people ?? []) {
    if (p.phone === me.phone) continue;
    // The tab above already says whose phone it is; the picker keeps to the name, so it fits beside the number.
    const o = h("option", "", p.agent ? say(lang, "pick.agent", { name: p.name }) : p.name);
    o.value = p.name;
    o.selected = p.name === other?.name;
    pick.append(o);
  }
}

function renderInbox(id: "a" | "b", list: Sms[]): void {
  const box = $(`sms-${id}`);
  box.replaceChildren();
  if (list.length === 0) {
    box.append(h("li", "sms-none", say(lang, "sms.empty")));
    return;
  }
  for (const m of [...list].reverse().slice(0, 12)) {
    const li = h("li", "sms");
    li.dataset.kind = m.kind;
    const d = new Date(m.at);
    li.append(h("p", "sms-text", m.text), h("time", "sms-time", `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`));
    box.append(li);
  }
}

function accountLabel(account: string): string {
  const fixed = `a.${account}`;
  if (fixed in copy) return say(lang, fixed as CopyKey);
  const cut = account.lastIndexOf(":");
  if (cut < 0) return account;
  const who = account.slice(0, cut);
  const part = account.slice(cut + 1);
  if (part === "spendable") return who;
  if (part === "locked") return say(lang, "a.locked", { name: who });
  return account;
}

function renderBooks(): void {
  const list = $("books-list");
  const sum = $("books-sum");
  list.replaceChildren();
  sum.replaceChildren();
  if (!ledger) return;
  const t = ledger.totals;
  const line = h("p", t.match ? "sum-ok" : "sum-bad", say(lang, t.match ? "led.match" : "led.nomatch", { a: group(t.ledgerSat), b: group(t.ecashSat) }));
  line.dataset.testid = "books-match";
  const keyset = ledger.mint.keyset.length > 16 ? `${ledger.mint.keyset.slice(0, 16)}...` : ledger.mint.keyset;
  sum.append(line, h("p", "sum-mint", say(lang, "led.mint", { name: ledger.mint.name, id: keyset })));
  if (ledger.rate) sum.append(h("p", "sum-rate", say(lang, ledger.rate.source === "fixed" ? "led.rate.fixed" : "led.rate.live", { rate: group(ledger.rate.xofPerBtc) })));
  if (ledger.entries.length === 0) list.append(h("li", "entry-none", say(lang, "led.empty")));
  for (const e of ledger.entries.slice(0, 8)) {
    const li = h("li", "entry");
    li.dataset.kind = e.kind;
    const key = `k.${e.kind}`;
    const head = h("p", "entry-kind", key in copy ? say(lang, key as CopyKey) : e.kind);
    head.append(h("code", "entry-hash", e.hash));
    li.append(head);
    for (const l of e.lines) {
      const row = h("p", l.sats < 0 ? "entry-line out" : "entry-line in");
      row.append(h("span", "entry-who", accountLabel(l.account)), h("span", "entry-sats", `${l.sats < 0 ? "-" : "+"}${group(l.sats)} sats`));
      li.append(row);
    }
    list.append(li);
  }
}

function renderAll(): void {
  paint(lang);
  renderLabels();
  renderGuide();
  renderInbox("a", smsA);
  renderInbox("b", smsB);
  renderBooks();
}

let polling = false;
let primed = false;
async function poll(): Promise<void> {
  if (polling || !info || document.hidden) return;
  polling = true;
  try {
    const [a, b, led] = await Promise.all([inbox(me.phone), other ? inbox(other.phone) : Promise.resolve([] as Sms[]), books()]);
    // The first read after a phone changes hands only shows what was already there.
    const newA = primed && a.length > smsA.length;
    const newB = primed && b.length > smsB.length;
    const changed = !primed || a.length !== smsA.length || b.length !== smsB.length || led.entries[0]?.seq !== ledger?.entries[0]?.seq || ledger === null;
    if (a.some((m) => m.kind === "deposit" && m.id > baseA)) funding = "idle";
    smsA = a;
    smsB = b;
    ledger = led;
    primed = true;
    if (newA) phoneA.flashSms();
    if (newB) phoneB.flashSms();
    // On a wide screen both phones are in view, so the other phone has been looked at.
    if (!lookedAtB && matchMedia("(min-width: 900px)").matches && progress().step === 4) lookedAtB = true;
    if (changed) renderAll();
    else renderGuide();
    $("down").hidden = true;
  } catch {
    $("down").hidden = false;
  } finally {
    polling = false;
  }
}

// ---------- start ----------

async function connect(): Promise<void> {
  for (;;) {
    try {
      info = await people();
      break;
    } catch {
      $("down").hidden = false;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  $("down").hidden = true;
  $("loading").hidden = true;
  $("stage").hidden = false;
  loadMe();
  keepMe();
  pickOther();
  phoneA = createPhone({ id: "a", code: info.ussd, lang, onTurn: () => void poll() });
  phoneB = createPhone({ id: "b", code: info.ussd, lang, onTurn: () => void poll() });
  $("slot-a").append(phoneA.el);
  $("slot-b").append(phoneB.el);
  $("tab-a").addEventListener("click", () => show("a"));
  $("tab-b").addEventListener("click", () => show("b"));
  $<HTMLSelectElement>("pick-b").addEventListener("change", (e) => handPhoneB((e.target as HTMLSelectElement).value));
  $("hint").addEventListener("click", () => $("guide").scrollIntoView({ behavior: "smooth", block: "start" }));
  new IntersectionObserver((seen) => {
    guideInView = seen[0]?.isIntersecting ?? true;
    const hint = $("hint");
    hint.hidden = guideInView || hint.dataset.step === "5" || !hint.hasChildNodes();
  }).observe($("guide"));
  await holdPhones();
  setInterval(() => void poll(), 1500);
  document.addEventListener("visibilitychange", () => void poll());
}

lang = mountLang((next) => {
  lang = next;
  if (info) {
    phoneA.setLang(next);
    phoneB.setLang(next);
    renderAll();
  }
});
void connect();
