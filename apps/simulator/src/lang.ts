// The page's language: which one to start in, the switch in the top bar, and filling every element
// marked data-t="key" with its sentence from copy.ts.
// Order of choice: ?lang= in the address, then the last choice kept in this browser, then the
// browser's own languages, then English.
import { type CopyKey, type Lang, LANGS, copy, say } from "./copy.ts";

const STORE = "melax.lang";
const isLang = (x: unknown): x is Lang => x === "en" || x === "fr" || x === "wo";

export function startLang(): Lang {
  const asked = new URLSearchParams(location.search).get("lang");
  if (isLang(asked)) return asked;
  try {
    const kept = localStorage.getItem(STORE);
    if (isLang(kept)) return kept;
  } catch {
    /* storage can be switched off; the page still works */
  }
  for (const tag of navigator.languages ?? [navigator.language]) {
    const two = String(tag).slice(0, 2).toLowerCase();
    if (isLang(two)) return two;
  }
  return "en";
}

/** Write every data-t sentence in `lang` and mark the active button of the switch. */
export function paint(lang: Lang, root: ParentNode = document): void {
  document.documentElement.lang = lang;
  for (const el of root.querySelectorAll<HTMLElement>("[data-t]")) {
    const key = el.dataset.t as CopyKey;
    if (!(key in copy)) continue;
    const vars: Record<string, string> = {};
    for (const [name, value] of Object.entries(el.dataset)) if (name.startsWith("v") && name.length > 1 && value !== undefined) vars[name.slice(1).toLowerCase()] = value;
    const text = say(lang, key, vars);
    el.textContent = text;
    // A sentence that exists in one language only (the note about the Wolof) hides where it is empty.
    if (el.hasAttribute("data-opt")) el.hidden = text === "";
  }
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-lang]")) b.setAttribute("aria-pressed", String(b.dataset.lang === lang));
}

/** Wire the switch. Returns the starting language; `onChange` runs after every switch, the first paint included. */
export function mountLang(onChange: (lang: Lang) => void): Lang {
  let lang = startLang();
  const set = (next: Lang): void => {
    lang = next;
    try {
      localStorage.setItem(STORE, next);
    } catch {
      /* see above */
    }
    paint(next);
    onChange(next);
  };
  for (const b of document.querySelectorAll<HTMLButtonElement>("[data-lang]")) {
    b.addEventListener("click", () => {
      const next = b.dataset.lang;
      if (isLang(next) && next !== lang) set(next);
    });
  }
  set(lang);
  return lang;
}

export { LANGS };
