import "./style.css";
import { demoChat, questionFor } from "./demo";
import { parseAgentResponse, type AgentResult, type Question, type State, type ToolResult } from "./schemas";

/*
 * Backend: restaurent-agent (FastAPI), a guided flow: cuisine -> restaurant -> date -> party size -> availability.
 *   POST /chat   { message, history: [{role, content}], state? }
 *                -> { google: { source, reply, tool_calls: [{name, args, output}] },
 *                     jev:    { source, available, understood: {question_id, choice, confidence, method},
 *                               next_question: {id, text, choices: [{key, label, message}]} },
 *                     state }   <- sent back unchanged with the next request
 *   GET  /health -> { status: "ok" }
 * google = Gemini's answer; jev = how it read the user's answer + the next question to ask.
 * The user can click a choice (sends its `message`) or type freely.
 */

function $<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`#${id} missing`);
  return e as T;
}
const chat = $("chat");
const form = $<HTMLFormElement>("form");
const input = $<HTMLInputElement>("input");
const apiUrl = $<HTMLInputElement>("apiUrl");
const demo = $<HTMLInputElement>("demo");
const showJson = $<HTMLInputElement>("showJson");
const health = $("health");
const sendBtn = form.querySelector("button") as HTMLButtonElement;

apiUrl.value = import.meta.env.VITE_API_URL ?? "http://localhost:8000";

type Turn = { role: "user" | "assistant"; content: string };
const history: Turn[] = [];
let state: State | null = null; // echoed back to the backend on every request

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
const jsonBlock = (v: unknown) => el("pre", "", JSON.stringify(v, null, 2));
const scrollDown = () => { chat.scrollTop = chat.scrollHeight; };
const base = () => apiUrl.value.replace(/\/+$/, "");

// ---------- Backend ----------
async function ask(message: string): Promise<unknown> {
  if (demo.checked) {
    await new Promise((r) => setTimeout(r, 500));
    return demoChat(message, state);
  }
  const res = await fetch(`${base()}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history, state }),
  });
  if (!res.ok) {
    const detail = await res.json().then((j: { detail?: unknown }) => (typeof j.detail === "string" ? j.detail : null), () => null);
    throw new Error(detail ?? `Backend returned ${res.status}`);
  }
  return res.json();
}

async function checkHealth(): Promise<void> {
  if (demo.checked) { health.className = "dot demo"; health.title = "Demo mode"; return; }
  try {
    const r = await fetch(`${base()}/health`);
    const ok = r.ok && ((await r.json()) as { status?: string }).status === "ok";
    health.className = ok ? "dot ok" : "dot bad";
    health.title = ok ? "Backend online" : "Backend unhealthy";
  } catch {
    health.className = "dot bad";
    health.title = "Backend unreachable";
  }
}

// ---------- Rendering ----------
function renderTool(t: ToolResult): HTMLElement {
  const box = el("div", "tool");

  if (!t.ok) {
    box.append(el("div", "tool-name", `🔧 ${t.name}`));
    box.append(el("div", "msg bot err", `Unexpected tool output (${t.issues})`), jsonBlock(t.raw));
    return box;
  }

  const c = t.call;
  const args = Object.entries(c.args).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ");
  box.append(el("div", "tool-name", `🔧 ${c.name}(${args})`));
  const grid = el("div", "cards");

  // Exhaustive switch: adding a tool to the schema without a renderer is a compile error.
  switch (c.name) {
    case "search_restaurants_by_cuisine": {
      if (!c.output.length) { box.append(el("div", "msg bot", "No restaurants found for that cuisine.")); break; }
      for (const r of c.output) {
        const card = el("div", "card");
        card.append(el("h3", "", r.name), el("div", "meta", `⭐ ${r.rating}  ·  ${r.price}`));
        grid.append(card);
      }
      box.append(grid);
      break;
    }
    case "get_restaurant_details": {
      if ("error" in c.output) { box.append(el("div", "msg bot err", c.output.error)); break; }
      const card = el("div", "card");
      const dl = el("dl");
      for (const [k, v] of Object.entries(c.output)) dl.append(el("dt", "", k), el("dd", "", String(v)));
      card.append(dl);
      grid.append(card);
      box.append(grid);
      break;
    }
    case "check_reservation_availability": {
      const ok = c.output.startsWith("✓");
      const card = el("div", "card");
      card.append(el("span", `badge ${ok ? "ok" : "bad"}`, ok ? "Available" : "Unavailable"), el("div", "meta", c.output));
      grid.append(card);
      box.append(grid);
      break;
    }
    default: {
      const _never: never = c;
      void _never;
    }
  }
  if (showJson.checked) box.append(jsonBlock(c.output));
  return box;
}

/** How Jev read the user's last answer. When Jev is down, the backend falls back to text matching. */
function renderJev(jev: NonNullable<AgentResult["jev"]>, toolNames: string[]): HTMLElement {
  const box = el("div", "jev");
  box.append(el("span", "jev-label", jev.source));
  const u = jev.understood;
  if (!jev.available) {
    box.append(el("span", "badge bad", "unavailable, matched by text"));
  } else {
    const pct = u.confidence === null ? "" : ` · ${Math.round(u.confidence * 100)}%`;
    box.append(el("span", "badge", `understood ${u.question_id}: ${u.choice ?? "no match"}${pct}`));
  }
  if (toolNames.length) box.append(el("span", "jev-note", `Gemini called ${toolNames.join(", ")}`));
  return box;
}

/** Jev's next question. Clicking a choice sends its `message`; typing in the box works too. */
function renderQuestion(q: Question): HTMLElement {
  const box = el("div", "options");
  box.append(el("div", "options-prompt", q.text));
  const row = el("div", "chips-row");
  for (const c of q.choices) {
    const b = el("button", c.key === "restart" ? "own" : "", c.label);
    b.type = "button";
    b.title = c.description ?? "";
    b.addEventListener("click", () => void send(c.message));
    row.append(b);
  }
  box.append(row);
  return box;
}

function renderResult(r: AgentResult): void {
  r.tools.forEach((t) => chat.append(renderTool(t)));
  if (r.reply) {
    const bubble = el("div", "msg bot");
    bubble.append(el("div", "source", r.source), document.createTextNode(r.reply));
    chat.append(bubble);
  }
  if (r.jev) {
    chat.append(renderJev(r.jev, r.tools.map((t) => (t.ok ? t.call.name : t.name))));
    if (showJson.checked) chat.append(jsonBlock({ jev: r.jev.understood, state: r.state }));
    chat.append(renderQuestion(r.jev.next_question));
  }
  scrollDown();
}

// ---------- Events ----------
async function send(text: string): Promise<void> {
  text = text.trim();
  if (!text) return;
  document.querySelectorAll(".options").forEach((n) => n.remove()); // old choices are stale now
  chat.append(el("div", "msg user", text));
  input.value = "";
  const typing = el("div", "msg bot typing", "Thinking…");
  chat.append(typing);
  scrollDown();
  sendBtn.disabled = true;
  try {
    const result = parseAgentResponse(await ask(text));
    history.push({ role: "user", content: text }, { role: "assistant", content: result.reply });
    if (result.state) state = result.state;
    renderResult(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    chat.append(el("div", "msg bot err", `${msg} (is the backend running at ${base()}? Or enable Demo mode.)`));
  } finally {
    typing.remove();
    sendBtn.disabled = false;
    input.focus();
    scrollDown();
  }
}

form.addEventListener("submit", (e) => { e.preventDefault(); void send(input.value); });
demo.addEventListener("change", () => void checkHealth());
apiUrl.addEventListener("change", () => void checkHealth());

chat.append(el("div", "msg bot", "Hi! I can find restaurants by cuisine, show details, and check reservation availability."));
chat.append(renderQuestion(questionFor({ asking: "cuisine" }))); // the backend's first question (flow.py START)
void checkHealth();
