/** Minimal I/O abstraction so gates work in a terminal, in tests, or in a custom UI. */
export interface GateIO {
    print(text: string): void;
    ask(question: string): Promise<string>;
    /** False when nobody can answer (CI, piped input). Gates then fail closed. */
    readonly interactive: boolean;
}
export declare class TerminalIO implements GateIO {
    readonly interactive: boolean;
    print(text: string): void;
    ask(question: string): Promise<string>;
}
/** Scripted answers, for tests and automation. */
export declare class ScriptedIO implements GateIO {
    private answers;
    readonly interactive = true;
    readonly output: string[];
    constructor(answers: string[]);
    print(text: string): void;
    ask(question: string): Promise<string>;
}
