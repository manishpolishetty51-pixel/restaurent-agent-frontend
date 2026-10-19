import { z } from "zod";

// ---- Tool output schemas (mirror restaurent-agent/tools.py) ----
export const RestaurantSummary = z.object({
  name: z.string(),
  rating: z.number(),
  price: z.string(),
});

export const RestaurantDetails = z.object({
  cuisine: z.string(),
  rating: z.number(),
  address: z.string(),
  phone: z.string(),
  hours: z.string(),
  speciality: z.string(),
});

export const ToolError = z.object({ error: z.string() });

/** The backend sends every tool result as a string; list/dict results are JSON text. */
const jsonText = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => {
    if (typeof v !== "string") return v;
    try { return JSON.parse(v); } catch { return v; }
  }, schema);

// ---- Tool calls: discriminated union on `name`; the backend sends name + args + output ----
export const ToolCall = z.discriminatedUnion("name", [
  z.object({
    name: z.literal("search_restaurants_by_cuisine"),
    args: z.object({ cuisine_type: z.string() }),
    output: jsonText(z.array(RestaurantSummary)),
  }),
  z.object({
    name: z.literal("get_restaurant_details"),
    args: z.object({ restaurant_name: z.string() }),
    output: jsonText(z.union([RestaurantDetails, ToolError])),
  }),
  z.object({
    name: z.literal("check_reservation_availability"),
    args: z.object({
      restaurant_name: z.string(),
      date: z.string(),
      party_size: z.number(),
    }),
    output: z.string(),
  }),
]);
export type ToolCall = z.infer<typeof ToolCall>;

// ---- Gemini's block: `google` in the /chat response ----
export const Google = z.object({
  source: z.string().default("Google Gemini"),
  reply: z.string(),
  tool_calls: z.array(z.unknown()),
});

// ---- Jev (TypeSafe) classifier block, from jev_decision.py ----
export const Jev = z.object({
  source: z.string().default("Jev"),
  intent: z.string(), // search | details | reservation | general | unknown
  confidence: z.number().nullable(),
  available: z.boolean(),
});
export type Jev = z.infer<typeof Jev>;

// ---- Clickable choices from options.py; `message: null` means "let me type my own" ----
export const Choice = z.object({
  label: z.string(),
  message: z.string().nullable(),
});
export const Options = z.object({
  prompt: z.string(),
  choices: z.array(Choice),
});
export type Options = z.infer<typeof Options>;

// ---- Full /chat response (main.py ChatResponse) ----
export const ChatResponse = z.object({
  google: Google,
  jev: Jev,
  options: Options,
});

export type ToolResult =
  | { ok: true; call: ToolCall }
  | { ok: false; name: string; raw: unknown; issues: string };

export type AgentResult = {
  source: string;
  reply: string;
  tools: ToolResult[];
  jev: Jev | null;
  options: Options | null;
};

export function parseAgentResponse(input: unknown): AgentResult {
  // Backend returned a non-conforming shape: still show it instead of failing.
  const base = ChatResponse.safeParse(input);
  if (!base.success) {
    const text = typeof input === "string" ? input : JSON.stringify(input, null, 2);
    return { source: "Raw response", reply: text, tools: [], jev: null, options: null };
  }
  const { google, jev, options } = base.data;
  const tools = google.tool_calls.map((raw): ToolResult => {
    const parsed = ToolCall.safeParse(raw);
    if (parsed.success) return { ok: true, call: parsed.data };
    const name = (raw as { name?: unknown } | null)?.name;
    return {
      ok: false,
      name: typeof name === "string" ? name : "unknown_tool",
      raw,
      issues: parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; "),
    };
  });
  return { source: google.source, reply: google.reply, tools, jev, options };
}
