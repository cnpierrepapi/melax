// One feature phone, drawn in HTML and CSS: a small screen, a line to type on, twelve keys.
// It shows exactly the text the gateway sends, nothing added. The keys type; the green key sends;
// the red key hangs up. A real keyboard works too (Enter sends, Escape hangs up).
// The phone knows one short code. Anything else is answered the way a network answers a code it
// does not know.
import { ussd } from "./api.ts";
import { type CopyKey, type Lang, say } from "./copy.ts";

export interface Phone {
  el: HTMLElement;
  /** Whose phone this is. Hangs up whatever was going on. */
  setOwner(number: string): void;
  setLang(lang: Lang): void;
  /** Light the SMS mark on the screen for a few seconds. */
  flashSms(): void;
  /** Put a dial string on the idle screen, ready for the green key. */
  preset(dial: string): void;
}

type Mode = "idle" | "busy" | "session" | "closed";
const KEYS: ReadonlyArray<readonly [string, string]> = [["1", ""], ["2", "abc"], ["3", "def"], ["4", "ghi"], ["5", "jkl"], ["6", "mno"], ["7", "pqrs"], ["8", "tuv"], ["9", "wxyz"], ["*", ""], ["0", "+"], ["#", ""]];

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text = ""): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text) el.textContent = text;
  return el;
}

export function createPhone(opts: { id: string; code: string; lang: Lang; onTurn?: () => void }): Phone {
  let lang = opts.lang;
  let number = "";
  let mode: Mode = "idle";
  let sessionId = "";
  let letters = false;
  let smsTimer = 0;
  let notice: CopyKey | null = null;

  const el = h("section", "phone");
  el.dataset.testid = `phone-${opts.id}`;
  const lcd = h("div", "lcd");
  const bar = h("div", "lcd-bar");
  const net = h("span", "lcd-net", "Melax");
  const smsMark = h("span", "lcd-sms");
  smsMark.hidden = true;
  bar.append(h("span", "lcd-bars"), net, smsMark);
  const text = h("pre", "lcd-text");
  text.setAttribute("aria-live", "polite");
  text.dataset.testid = `screen-${opts.id}`;
  const input = h("input", "lcd-input");
  input.type = "text";
  input.inputMode = "tel";
  input.autocomplete = "off";
  input.autocapitalize = "off";
  input.spellcheck = false;
  input.maxLength = 60;
  input.dataset.testid = `input-${opts.id}`;
  lcd.append(bar, text, input);

  const soft = h("div", "softkeys");
  const ok = h("button", "key key-ok");
  const del = h("button", "key key-del");
  const abc = h("button", "key key-abc", "abc");
  const end = h("button", "key key-end");
  for (const b of [ok, del, abc, end]) b.type = "button";
  ok.dataset.testid = `ok-${opts.id}`;
  end.dataset.testid = `end-${opts.id}`;
  abc.setAttribute("aria-pressed", "false");
  soft.append(ok, del, abc, end);

  const pad = h("div", "keys");
  for (const [digit, sub] of KEYS) {
    const k = h("button", "key key-num");
    k.type = "button";
    k.dataset.key = digit;
    k.append(h("span", "key-digit", digit), h("span", "key-sub", sub));
    k.addEventListener("click", () => type(digit));
    pad.append(k);
  }
  el.append(h("div", "phone-ear"), lcd, soft, pad);

  const coarse = matchMedia("(pointer: coarse)").matches;
  const focus = (): void => {
    // On a touch screen, focusing the line would open the system keyboard over our keys.
    if (!coarse) input.focus({ preventScroll: true });
  };

  function setLetters(on: boolean): void {
    letters = on;
    input.inputMode = on ? "text" : "tel";
    abc.setAttribute("aria-pressed", String(on));
    if (on) input.focus({ preventScroll: true });
  }

  function draw(): void {
    el.dataset.mode = mode;
    ok.textContent = say(lang, "key.ok");
    del.textContent = say(lang, "key.del");
    end.textContent = say(lang, "key.end");
    input.setAttribute("aria-label", number);
    if (mode === "idle") text.textContent = notice ? say(lang, notice, { ussd: opts.code }) : say(lang, "phone.idle");
    if (mode === "busy") text.textContent = say(lang, "phone.sending");
    input.hidden = mode === "busy" || mode === "closed";
    for (const b of el.querySelectorAll<HTMLButtonElement>("button")) b.disabled = mode === "busy";
  }

  function idle(msg: CopyKey | null = null): void {
    mode = "idle";
    sessionId = "";
    notice = msg;
    input.value = opts.code;
    setLetters(false);
    draw();
  }

  function type(ch: string): void {
    // The first key after a closing screen only clears it: otherwise the digit lands after "#2580#".
    if (mode === "closed") return idle();
    if (mode !== "idle" && mode !== "session") return;
    if (input.value.length < input.maxLength) input.value += ch;
    focus();
  }

  /** `#2580#` and `#2580*2*771234567*500#` are ours. Nothing else is. */
  function known(dial: string): boolean {
    const stem = opts.code.slice(0, -1);
    return dial === opts.code || (dial.startsWith(stem + "*") && /^[*#][0-9*]+#$/.test(dial));
  }

  async function send(): Promise<void> {
    // On a closing screen the green key dials again, so "press the green key" is always the way in.
    if (mode === "closed") idle();
    if (mode !== "idle" && mode !== "session") return;
    const typed = input.value.trim();
    if (typed === "") return focus();
    const first = mode === "idle";
    if (first && !known(typed)) return idle("phone.wrongcode");
    if (first) sessionId = `web-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    mode = "busy";
    draw();
    try {
      const r = await ussd(first ? { sessionId, phone: number, input: "", dial: typed } : { sessionId, phone: number, input: typed });
      mode = r.continue ? "session" : "closed";
      input.value = "";
      setLetters(false);
      draw();
      text.textContent = r.message;
      if (r.continue) focus();
    } catch {
      idle("phone.neterr");
    }
    opts.onTurn?.();
  }

  ok.addEventListener("click", () => void send());
  end.addEventListener("click", () => idle());
  del.addEventListener("click", () => {
    input.value = input.value.slice(0, -1);
    focus();
  });
  abc.addEventListener("click", () => setLetters(!letters));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      void send();
    }
    if (e.key === "Escape") idle();
  });
  // A tap on the closed screen puts the phone back to its idle screen.
  lcd.addEventListener("click", () => {
    if (mode === "closed") idle();
  });

  idle();
  return {
    el,
    setOwner(next: string) {
      number = next;
      idle();
    },
    setLang(next: Lang) {
      lang = next;
      draw();
    },
    flashSms() {
      smsMark.textContent = say(lang, "phone.newsms");
      smsMark.hidden = false;
      clearTimeout(smsTimer);
      smsTimer = window.setTimeout(() => {
        smsMark.hidden = true;
      }, 6000);
    },
    preset(dial: string) {
      if (mode === "idle" || mode === "closed") {
        idle();
        input.value = dial;
      }
    },
  };
}
