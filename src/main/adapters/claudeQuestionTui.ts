import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SessionTranscriptResult, UnifiedBlock } from '../../shared/types';

const execFileAsync = promisify(execFile);

export type QuestionBlock = Extract<UnifiedBlock, { type: 'question' }>;
export type QuestionItem = QuestionBlock['questions'][number];

export type ResolvedQuestionChoice =
  | { kind: 'option'; index: number; label: string }
  | { kind: 'custom'; text: string };

const REMOTE_PATH = 'export PATH=/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH;';

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function normalizeLabel(s: string): string {
  return s.replace(/\s*\(recommended\)\s*$/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Returns the trailing unanswered `question` block from a transcript, if Claude is
 * currently waiting on an `AskUserQuestion` prompt.
 */
export function extractPendingQuestionBlock(
  transcript: SessionTranscriptResult | null | undefined
): QuestionBlock | null {
  if (!transcript || transcript.messages.length === 0) return null;
  const lastMsg = transcript.messages[transcript.messages.length - 1];
  if (!lastMsg || lastMsg.role !== 'assistant') return null;
  for (let i = lastMsg.blocks.length - 1; i >= 0; i--) {
    const b = lastMsg.blocks[i];
    if (b.type === 'question') {
      const answered = Boolean(b.answered) || b.questions.some((q) => Boolean(q.answer));
      return answered ? null : b;
    }
  }
  return null;
}

/**
 * Matches a single answer string against a question's predefined option labels.
 */
export function matchOptionChoice(q: QuestionItem, rawAnswer: string): ResolvedQuestionChoice {
  const answer = rawAnswer.trim();
  // Pass 1: exact case-sensitive match (essential when options only differ by casing, e.g. "Superharness" vs "SuperHarness")
  for (let i = 0; i < q.options.length; i++) {
    if (q.options[i].trim() === answer) {
      return { kind: 'option', index: i, label: q.options[i] };
    }
  }
  // Pass 2: case-insensitive / stripped "(Recommended)" suffix match
  const normAnswer = normalizeLabel(answer);
  for (let i = 0; i < q.options.length; i++) {
    if (normalizeLabel(q.options[i]) === normAnswer) {
      return { kind: 'option', index: i, label: q.options[i] };
    }
  }
  return { kind: 'custom', text: answer };
}

/**
 * Parses a reply formatted as `<Question>: <Answer>` (one per question, as sent by
 * Super Harness Desktop and iOS) or a single answer for 1-question prompts, and
 * resolves each question to its option index or custom text.
 */
export function resolveClaudeQuestionAnswers(
  questions: QuestionItem[],
  prompt: string
): ResolvedQuestionChoice[] | null {
  const trimmed = prompt.trim();
  if (!trimmed || questions.length === 0) return null;

  // 1. Exact `<question>: <answer>` prefix matching (handles colons & newlines inside question text)
  const positions: Array<{ qi: number; start: number; valueStart: number }> = [];
  let searchFrom = 0;
  for (let qi = 0; qi < questions.length; qi++) {
    const prefix = `${questions[qi].question}:`;
    const idx = trimmed.indexOf(prefix, searchFrom);
    if (idx !== -1) {
      positions.push({ qi, start: idx, valueStart: idx + prefix.length });
      searchFrom = idx + prefix.length;
    }
  }

  if (positions.length === questions.length) {
    return positions.map((pos, idx) => {
      const end = idx + 1 < positions.length ? positions[idx + 1].start : trimmed.length;
      const answerText = trimmed.slice(pos.valueStart, end).trim();
      return matchOptionChoice(questions[pos.qi], answerText);
    });
  }

  // 2. Single-question fallback: bare option label or custom text
  if (questions.length === 1) {
    const prefix = `${questions[0].question}:`;
    const body = trimmed.startsWith(prefix) ? trimmed.slice(prefix.length).trim() : trimmed;
    return [matchOptionChoice(questions[0], body)];
  }

  // 3. Multi-line fallback: exact number of non-empty lines matching question count
  const lines = trimmed
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length === questions.length) {
    return lines.map((line, qi) => {
      const colonIdx = line.indexOf(': ');
      const candidate = colonIdx !== -1 ? line.slice(colonIdx + 2).trim() : line;
      return matchOptionChoice(questions[qi], candidate);
    });
  }

  return null;
}

/** Checks whether captured tmux pane text is currently showing Claude Code's AskUserQuestion TUI. */
export function detectClaudeQuestionPaneState(paneText: string): 'review' | 'picker' | 'none' {
  if (/Review your answers/i.test(paneText) && /Submit answers/i.test(paneText)) {
    return 'review';
  }
  if (
    /Enter to select/i.test(paneText) ||
    /Type something/i.test(paneText) ||
    /←\s+[☐☒✔]/.test(paneText) ||
    /Submit\s+→/.test(paneText)
  ) {
    return 'picker';
  }
  return 'none';
}

/**
 * Generates a POSIX shell script that drives Claude Code's interactive AskUserQuestion
 * TUI inside a remote tmux pane over SSH, checking live pane state before sending keys
 * and automatically confirming the final "Review your answers → Submit answers" screen.
 * Exits with code 42 if the pane is no longer showing an AskUserQuestion picker so the
 * caller can fall back to normal chat typing.
 */
export function buildRemoteClaudeQuestionTmuxScript(
  target: string,
  questions: QuestionItem[],
  choices: ResolvedQuestionChoice[]
): string {
  const t = shQuote(target);
  const lines: string[] = [
    REMOTE_PATH,
    `PANE=$(tmux capture-pane -p -t ${t} 2>/dev/null || true)`,
    'if printf "%s" "$PANE" | grep -q "Review your answers" && printf "%s" "$PANE" | grep -q "Submit answers"; then',
    `  tmux send-keys -t ${t} C-m`,
    '  exit 0',
    'fi',
    'if ! printf "%s" "$PANE" | grep -Eq "Enter to select|Type something|Submit  →|←  [☐☒✔]"; then',
    '  exit 42',
    'fi',
  ];

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const choice = choices[i];
    if (!choice) break;
    if (choice.kind === 'option') {
      for (let step = 0; step < choice.index; step++) {
        lines.push(`tmux send-keys -t ${t} Down`, 'sleep 0.08');
      }
      lines.push(`tmux send-keys -t ${t} C-m`, 'sleep 0.28');
    } else {
      for (let step = 0; step < q.options.length; step++) {
        lines.push(`tmux send-keys -t ${t} Down`, 'sleep 0.08');
      }
      lines.push(
        'sleep 0.1',
        `tmux send-keys -t ${t} -l ${shQuote(choice.text)}`,
        'sleep 0.12',
        `tmux send-keys -t ${t} C-m`,
        'sleep 0.28'
      );
    }
  }

  // Multi-question prompts show "Review your answers → 1. Submit answers"; confirm if present.
  lines.push(
    'for _try in 1 2 3; do',
    `  PANE=$(tmux capture-pane -p -t ${t} 2>/dev/null || true)`,
    '  if printf "%s" "$PANE" | grep -q "Submit answers"; then',
    `    tmux send-keys -t ${t} C-m`,
    '    break',
    '  fi',
    '  sleep 0.2',
    'done'
  );

  return lines.join('\n') + '\n';
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Drives Claude Code's interactive AskUserQuestion TUI inside a local tmux pane.
 * Returns `true` if the picker was detected and answered, or `false` if the pane
 * is not showing AskUserQuestion (caller should fall back to normal chat typing).
 */
export async function driveLocalClaudeQuestionTmux(
  target: string,
  questions: QuestionItem[],
  choices: ResolvedQuestionChoice[]
): Promise<boolean> {
  const capture = async (): Promise<string> => {
    try {
      const { stdout } = await execFileAsync('tmux', ['capture-pane', '-p', '-t', target], {
        timeout: 2500,
      });
      return stdout;
    } catch {
      return '';
    }
  };

  const state = detectClaudeQuestionPaneState(await capture());
  if (state === 'none') return false;
  if (state === 'review') {
    await execFileAsync('tmux', ['send-keys', '-t', target, 'C-m'], { timeout: 4000 });
    return true;
  }

  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const choice = choices[i];
    if (!choice) break;
    if (choice.kind === 'option') {
      for (let step = 0; step < choice.index; step++) {
        await execFileAsync('tmux', ['send-keys', '-t', target, 'Down'], { timeout: 3000 });
        await sleep(80);
      }
      await execFileAsync('tmux', ['send-keys', '-t', target, 'C-m'], { timeout: 4000 });
      await sleep(280);
    } else {
      for (let step = 0; step < q.options.length; step++) {
        await execFileAsync('tmux', ['send-keys', '-t', target, 'Down'], { timeout: 3000 });
        await sleep(80);
      }
      await sleep(100);
      await execFileAsync('tmux', ['send-keys', '-t', target, '-l', choice.text], { timeout: 4000 });
      await sleep(120);
      await execFileAsync('tmux', ['send-keys', '-t', target, 'C-m'], { timeout: 4000 });
      await sleep(280);
    }
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    const after = await capture();
    if (/Submit answers/i.test(after)) {
      await execFileAsync('tmux', ['send-keys', '-t', target, 'C-m'], { timeout: 4000 });
      break;
    }
    await sleep(200);
  }

  return true;
}
