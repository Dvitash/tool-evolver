from pathlib import Path

path = Path("fixtures/e2e/src/process-harness.ts")
source = path.read_text()
old = '''              implementationCode: `
export default async function run(input: { command: string; flag?: string }) {
  if (input.command === "fail") {
    throw new Error("Simulated execution failure in generated tool");
  }
  return {
    status: "ok",
    executedCommand: input.command,
    flag: input.flag ?? "none",
    timestamp: new Date().toISOString(),
  };
}
`.trim(),'''
new = '''              implementationCode: `
import { defineTool, type ToolContext } from "@tool-evolver/runtime";
import { z } from "zod";

export const InputSchema = z.object({
  command: z.string().min(1),
  flag: z.string().optional(),
});
export type ToolInput = z.infer<typeof InputSchema>;

export const OutputSchema = z.object({
  status: z.literal("ok"),
  executedCommand: z.string(),
  flag: z.string(),
});
export type ToolOutput = z.infer<typeof OutputSchema>;

export default defineTool<ToolInput, ToolOutput>(
  async (context: ToolContext<ToolInput>): Promise<ToolOutput> => {
    const { input } = context;
    if (input.command === "fail") {
      throw new Error("Simulated execution failure in generated tool");
    }
    return {
      status: "ok",
      executedCommand: input.command,
      flag: input.flag ?? "none",
    };
  },
);
`.trim(),'''
if old in source:
    source = source.replace(old, new, 1)
elif 'export default defineTool<ToolInput, ToolOutput>' not in source:
    raise SystemExit("mock inference candidate source block not found")
path.write_text(source)
print("FIN-001 deterministic candidate now satisfies validation contract")
