import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

/** Minimal I/O abstraction so gates work in a terminal, in tests, or in a custom UI. */
export interface GateIO {
  print(text: string): void;
  ask(question: string): Promise<string>;
  /** False when nobody can answer (CI, piped input). Gates then fail closed. */
  readonly interactive: boolean;
}

export class TerminalIO implements GateIO {
  readonly interactive = Boolean(stdin.isTTY);

  print(text: string): void {
    stdout.write(text + "\n");
  }

  async ask(question: string): Promise<string> {
    if (!this.interactive) throw new Error("Approval needed but no interactive terminal is attached.");
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      return (await rl.question(question)).trim();
    } finally {
      rl.close();
    }
  }
}

/** Scripted answers, for tests and automation. */
export class ScriptedIO implements GateIO {
  readonly interactive = true;
  readonly output: string[] = [];

  constructor(private answers: string[]) {}

  print(text: string): void {
    this.output.push(text);
  }

  async ask(question: string): Promise<string> {
    this.output.push(question);
    const a = this.answers.shift();
    if (a === undefined) throw new Error(`ScriptedIO ran out of answers at: ${question}`);
    return a;
  }
}
