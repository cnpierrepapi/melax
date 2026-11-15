// The landing page: the language switch, and the phone in the first screen, which plays four real
// screens of a payment in a loop (the menu, the question, the code, the receipt).
import { type Lang, screens } from "./copy.ts";
import { mountLang } from "./lang.ts";

const screen = document.getElementById("hero-screen") as HTMLElement;
const typed = document.getElementById("hero-typed") as HTMLElement;
/** What the keypad "types" under each screen before the next one comes. */
const TYPED = ["2", "1", "•••••", ""];
const still = matchMedia("(prefers-reduced-motion: reduce)").matches;

let lang: Lang = "en";
let at = 0;

function show(): void {
  screen.textContent = screens[lang][at] ?? "";
  typed.textContent = "";
  if (still) return;
  window.setTimeout(() => {
    typed.textContent = TYPED[at] ?? "";
  }, 1400);
}

lang = mountLang((next) => {
  lang = next;
  show();
});
if (!still) {
  window.setInterval(() => {
    at = (at + 1) % screens[lang].length;
    show();
  }, 2800);
}
