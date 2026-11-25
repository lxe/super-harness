import type { Meta, StoryObj } from '@storybook/react';
import React from 'react';
import { Bot, History, Terminal } from 'lucide-react';
import { CollapsibleCard, DisclosureRow } from './CollapsibleCard';

const meta: Meta = {
  title: 'Primitives/CollapsibleCard & Disclosure',
};
export default meta;

export const Variants: StoryObj = {
  render: () => (
    <div className="w-[560px] space-y-3 p-4 bg-surface-canvas rounded-2xl border border-line-hairline">
      <CollapsibleCard
        icon={<Bot className="w-3.5 h-3.5 text-indigo-300" />}
        title="From agent · Muse Supervisor"
        preview="Finished validation on decode_layer and pushed changes to dev branch…"
        meta="2.4k chars"
      >
        <p className="text-body text-ink-secondary">
          Full message body from the peer agent appears cleanly inside the collapsible card.
        </p>
      </CollapsibleCard>

      <CollapsibleCard
        icon={<History className="w-3.5 h-3.5 text-amber-300" />}
        title="Compacted conversation summary"
        preview="This session is being continued from a previous conversation…"
        meta="20.6k chars"
      >
        <p className="text-caption text-ink-muted">Compacted summary body.</p>
      </CollapsibleCard>

      <CollapsibleCard
        variant="recessed"
        icon={<Terminal className="w-3 h-3 text-ink-muted" />}
        title={<code className="font-mono">npm run typecheck && npm run build</code>}
        meta="0.9s"
        defaultOpen
      >
        <pre className="text-micro font-mono text-ink-muted whitespace-pre-wrap">
          ✓ 1639 modules transformed. Built in 890ms.
        </pre>
      </CollapsibleCard>

      <DisclosureRow label="Ran 3 commands · Edited 2 files">
        <div className="text-caption text-ink-muted">Nested trace blocks render here cleanly.</div>
      </DisclosureRow>
    </div>
  ),
};
