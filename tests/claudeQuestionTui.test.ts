import { describe, expect, it } from 'vitest';
import {
  buildRemoteClaudeQuestionTmuxScript,
  detectClaudeQuestionPaneState,
  extractPendingQuestionBlock,
  resolveClaudeQuestionAnswers,
  type QuestionItem,
} from '../src/main/adapters/claudeQuestionTui';

const TWO_QUESTIONS: QuestionItem[] = [
  {
    question:
      'Which spelling of the product name do you want everywhere? Your message came through dictation, so I want to be sure before renaming the App Store listing.',
    options: ['Superharness', 'SuperHarness', 'Super Harness'],
  },
  {
    question: 'How far should the rename go right now? Note: desktop belongs elsewhere.',
    options: [
      'Site + listing + new build (Recommended)',
      'Site + listing only',
      'Everything, no resubmit yet',
    ],
  },
];

describe('claudeQuestionTui', () => {
  it('resolves multi-question answers with colons inside questions to exact option indices', () => {
    const reply =
      `${TWO_QUESTIONS[0].question}: SuperHarness\n` +
      `${TWO_QUESTIONS[1].question}: Everything, no resubmit yet`;
    const resolved = resolveClaudeQuestionAnswers(TWO_QUESTIONS, reply);
    expect(resolved).toEqual([
      { kind: 'option', index: 1, label: 'SuperHarness' },
      { kind: 'option', index: 2, label: 'Everything, no resubmit yet' },
    ]);
  });

  it('matches options ignoring (Recommended) suffix and falls back to custom text', () => {
    const reply =
      `${TWO_QUESTIONS[0].question}: Super-Harness\n` +
      `${TWO_QUESTIONS[1].question}: Site + listing + new build`;
    const resolved = resolveClaudeQuestionAnswers(TWO_QUESTIONS, reply);
    expect(resolved).toEqual([
      { kind: 'custom', text: 'Super-Harness' },
      { kind: 'option', index: 0, label: 'Site + listing + new build (Recommended)' },
    ]);
  });

  it('detects picker vs review vs normal pane states', () => {
    expect(detectClaudeQuestionPaneState('Review your answers\n❯ 1. Submit answers\n  2. Cancel')).toBe('review');
    expect(detectClaudeQuestionPaneState('←  ☐ Name  ☐ Scope  ✔ Submit  →\n❯ 1. Superharness\n  4. Type something.')).toBe('picker');
    expect(detectClaudeQuestionPaneState('❯ \n  bypass permissions on')).toBe('none');
  });

  it('generates Down presses for option indices and confirms Submit answers on remote tmux', () => {
    const choices = resolveClaudeQuestionAnswers(
      TWO_QUESTIONS,
      `${TWO_QUESTIONS[0].question}: Super Harness\n${TWO_QUESTIONS[1].question}: Site + listing only`
    )!;
    const script = buildRemoteClaudeQuestionTmuxScript('sh-ios-rows:0.0', TWO_QUESTIONS, choices);
    // Question 1: index 2 -> 2 Down presses + C-m; Question 2: index 1 -> 1 Down press + C-m
    const downCount = (script.match(/tmux send-keys -t 'sh-ios-rows:0\.0' Down/g) || []).length;
    expect(downCount).toBe(3);
    expect(script).toContain('grep -q "Submit answers"');
    expect(script).toContain('exit 42');
  });

  it('extracts only trailing unanswered question blocks', () => {
    const pending = extractPendingQuestionBlock({
      sessionId: 'claude:1',
      totalCount: 1,
      hasMore: false,
      sourceMtimeMs: 1,
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          timestamp: 1,
          blocks: [{ type: 'question', questions: TWO_QUESTIONS, answered: false }],
        },
      ],
    });
    expect(pending?.questions).toHaveLength(2);

    const answered = extractPendingQuestionBlock({
      sessionId: 'claude:1',
      totalCount: 1,
      hasMore: false,
      sourceMtimeMs: 1,
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          timestamp: 1,
          blocks: [{ type: 'question', questions: TWO_QUESTIONS, answered: true }],
        },
      ],
    });
    expect(answered).toBeNull();
  });
});
