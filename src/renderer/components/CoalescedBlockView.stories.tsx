import type { Meta, StoryObj } from '@storybook/react';
import React from 'react';
import type { UnifiedMessage } from '../../shared/types';
import { CoalescedBlockView, CollapsedTraceGroup, UserMessageView } from './CoalescedBlockView';

const meta: Meta = {
  title: 'Domain/Conversation Blocks',
  parameters: { layout: 'padded' },
};
export default meta;

const agentMsg: UnifiedMessage = {
  id: 'm-agent',
  role: 'user',
  timestamp: Date.now(),
  harnessMeta: { sourceKind: 'agent', senderName: 'Release Ops Agent' },
  blocks: [
    {
      type: 'text',
      text: 'Another Claude session sent a message:\n<cross-session-message name="Release Ops Agent">Published the updated landing copy and verified links on staging.</cross-session-message>',
    },
  ],
};

const compactedMsg: UnifiedMessage = {
  id: 'm-compact',
  role: 'user',
  timestamp: Date.now(),
  harnessMeta: { sourceKind: 'compaction' },
  blocks: [
    {
      type: 'text',
      text: 'This session is being continued from a previous conversation that ran out of context.\n\n1. Primary Request and Intent: Build cohesive UI primitives and Storybook.\n2. Completed work: Defined semantic design tokens.',
    },
  ],
};

const shortHumanMsg: UnifiedMessage = {
  id: 'm-human',
  role: 'user',
  timestamp: Date.now(),
  blocks: [{ type: 'text', text: 'add ability to pin chats to superharness top' }],
};

const failedHumanMsg: UnifiedMessage = {
  id: 'm-failed',
  role: 'user',
  timestamp: Date.now(),
  error: 'Harness process exited with code 1: connection refused',
  blocks: [
    {
      type: 'text',
      text: 'Archive the old image-generation threads we do not need anymore.',
    },
  ],
};

export const FailedUserMessage: StoryObj = {
  render: () => (
    <div className="w-[680px] max-w-full space-y-5 p-6 bg-surface-canvas rounded-2xl border border-line-hairline">
      <UserMessageView
        msg={failedHumanMsg}
        onRetryFailed={() => {}}
        onDismissFailed={() => {}}
      />
    </div>
  ),
};

export const FullConversationFlow: StoryObj = {
  render: () => (
    <div className="w-[680px] max-w-full space-y-5 p-6 bg-surface-canvas rounded-2xl border border-line-hairline">
      <UserMessageView msg={compactedMsg} />
      <UserMessageView msg={agentMsg} />
      <UserMessageView msg={shortHumanMsg} />

      <div className="space-y-2.5">
        <CollapsedTraceGroup
          blocks={[
            { type: 'thinking', text: 'Inspecting sidebar state and persistence store…' },
            {
              type: 'command',
              command: 'npm run typecheck && npm run build',
              output: '✓ 1639 modules transformed in 890ms',
              exitCode: 0,
            },
            {
              type: 'file_change',
              changes: [
                {
                  path: 'src/renderer/ui/tokens.css',
                  kind: 'write',
                  diff: '+ --color-surface-rail: #111215;\n+ --color-surface-canvas: #16171b;',
                },
              ],
            },
          ]}
        />

        <CoalescedBlockView
          block={{
            type: 'text',
            text: 'Added **Pin to Superharness top** across the sidebar, context menu, and session header.',
          }}
        />

        <CoalescedBlockView
          block={{
            type: 'question',
            answered: true,
            questions: [
              {
                question: 'How should we structure the UI library and Storybook?',
                options: [
                  '(Recommended) Storybook 8 (Vite) + src/renderer/ui/',
                  'Built-in /storybook dev route',
                ],
                answer: '(Recommended) Storybook 8 (Vite) + src/renderer/ui/ design system',
              },
              {
                question: 'How far should we take the first pass?',
                options: [
                  '(Recommended) Full pass: design tokens + primitives + Storybook + migrate all existing views',
                  'Incremental',
                ],
                answer:
                  '(Recommended) Full pass: design tokens + primitives + Storybook + migrate all existing views',
              },
            ],
          }}
        />

        <CoalescedBlockView
          block={{
            type: 'question',
            questions: [
              {
                question: 'Unanswered pending question example?',
                options: ['Option A', 'Option B'],
              },
            ],
          }}
        />
      </div>
    </div>
  ),
};
