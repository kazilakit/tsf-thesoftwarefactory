// The wizard's question layer: numbered menus over Node readline, and a scripted prompter for tests.
import { createInterface } from 'node:readline/promises';

/** Ctrl-C or the end of input: the wizard stops. */
export class PromptClosedError extends Error {
  constructor() {
    super('input closed');
    this.name = 'PromptClosedError';
  }
}

export interface Prompter {
  say(text: string): void;
  /** Trimmed; empty takes `default`; a `validate` message is shown and the question asked again. */
  ask(question: string, o?: { default?: string; validate?: (v: string) => string | null }): Promise<string>;
  /** Numbered options, 1-based; a bad number asks again. */
  choose<T extends string>(question: string, options: { value: T; label: string }[], o?: { default?: T }): Promise<T>;
  /** y/n; empty takes `def`. */
  confirm(question: string, def: boolean): Promise<boolean>;
  /** Trimmed lines until an empty one. */
  lines(question: string): Promise<string[]>;
}

/** The menus over one raw "write a prompt, read a line" function. */
function prompter(raw: (prompt: string) => Promise<string>, say: (text: string) => void): Prompter {
  const ask: Prompter['ask'] = async (question, o = {}) => {
    const suffix = o.default ? ` [${o.default}]` : '';
    for (;;) {
      const answer = (await raw(`${question}${suffix}: `)).trim();
      const v = answer === '' && o.default !== undefined ? o.default : answer;
      const error = o.validate?.(v) ?? null;
      if (error === null) return v;
      say(error);
    }
  };
  return {
    say,
    ask,
    async choose(question, options, o = {}) {
      say(question);
      options.forEach((opt, i) => say(`  ${i + 1}. ${opt.label}`));
      const def = o.default === undefined ? -1 : options.findIndex((x) => x.value === o.default);
      const bad = `Enter a number from 1 to ${options.length}`;
      const n = await ask('Choose', {
        ...(def >= 0 ? { default: String(def + 1) } : {}),
        validate: (v) => (/^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= options.length ? null : bad),
      });
      return options[Number(n) - 1]!.value;
    },
    async confirm(question, def) {
      for (;;) {
        const a = (await raw(`${question} ${def ? '[Y/n]' : '[y/N]'} `)).trim().toLowerCase();
        if (a === '') return def;
        if (a === 'y' || a === 'yes') return true;
        if (a === 'n' || a === 'no') return false;
        say('Answer y or n');
      }
    },
    async lines(question) {
      say(question);
      const out: string[] = [];
      for (;;) {
        const l = (await raw('> ')).trim();
        if (l === '') return out;
        out.push(l);
      }
    },
  };
}

/**
 * The terminal prompter. Lines are queued as they arrive (piped input may come before the question), and input is
 * paused while no question waits, so a child process (gh) can read the terminal. Ctrl-C or the end of input rejects
 * the pending question, and every later one, with PromptClosedError.
 */
export function readlinePrompter(
  input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout,
): Prompter & { close(): void } {
  const rl = createInterface({ input, output, terminal: (output as { isTTY?: boolean }).isTTY === true });
  const queue: string[] = [];
  let waiting: { resolve: (l: string) => void; reject: (e: Error) => void } | null = null;
  let closed = false;
  rl.on('line', (l: string) => {
    if (waiting) {
      const w = waiting;
      waiting = null;
      rl.pause();
      w.resolve(l);
    } else queue.push(l);
  });
  const shut = () => {
    if (closed) return;
    closed = true;
    const w = waiting;
    waiting = null;
    w?.reject(new PromptClosedError());
    rl.close();
  };
  rl.on('close', shut);
  rl.on('SIGINT', shut);
  rl.pause();
  // The question is readline's own prompt while it waits, so a redraw on a terminal (backspace, line wrap) keeps it.
  const raw = (prompt: string): Promise<string> => {
    if (queue.length) {
      output.write(prompt);
      return Promise.resolve(queue.shift()!);
    }
    if (closed) {
      output.write(prompt);
      return Promise.reject(new PromptClosedError());
    }
    return new Promise((resolve, reject) => {
      waiting = { resolve, reject };
      rl.setPrompt(prompt);
      rl.prompt();
    });
  };
  return { ...prompter(raw, (t) => output.write(`${t}\n`)), close: shut };
}

/** Test prompter: answers in order; `transcript` holds every line said and every prompt with its answer. */
export function scriptedPrompter(answers: string[]): Prompter & { transcript: string[] } {
  const transcript: string[] = [];
  const left = [...answers];
  const raw = async (prompt: string): Promise<string> => {
    if (left.length === 0) {
      transcript.push(prompt);
      throw new PromptClosedError();
    }
    const a = left.shift()!;
    transcript.push(`${prompt}${a}`);
    return a;
  };
  return { ...prompter(raw, (t) => transcript.push(t)), transcript };
}
