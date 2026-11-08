import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
export class TerminalIO {
    interactive = Boolean(stdin.isTTY);
    print(text) {
        stdout.write(text + "\n");
    }
    async ask(question) {
        if (!this.interactive)
            throw new Error("Approval needed but no interactive terminal is attached.");
        const rl = createInterface({ input: stdin, output: stdout });
        try {
            return (await rl.question(question)).trim();
        }
        finally {
            rl.close();
        }
    }
}
/** Scripted answers, for tests and automation. */
export class ScriptedIO {
    answers;
    interactive = true;
    output = [];
    constructor(answers) {
        this.answers = answers;
    }
    print(text) {
        this.output.push(text);
    }
    async ask(question) {
        this.output.push(question);
        const a = this.answers.shift();
        if (a === undefined)
            throw new Error(`ScriptedIO ran out of answers at: ${question}`);
        return a;
    }
}
//# sourceMappingURL=io.js.map