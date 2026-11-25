import type { Meta, StoryObj } from '@storybook/react';
import React, { useState } from 'react';
import { FileCode2, Settings } from 'lucide-react';
import { Button } from './Button';
import { Field, Input } from './Input';
import { Drawer, Modal } from './Modal';

const meta: Meta = {
  title: 'Primitives/Modal & Drawer',
};
export default meta;

export const ModalDemo: StoryObj = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <div>
        <Button variant="primary" onClick={() => setOpen(true)}>
          Open Modal
        </Button>
        <Modal
          open={open}
          onClose={() => setOpen(false)}
          title="Super Harness Settings"
          subtitle="Configure apps, discovery, and Master Orchestrator"
          icon={<Settings className="w-4 h-4" />}
          footer={
            <>
              <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => setOpen(false)}>Save</Button>
            </>
          }
        >
          <Field label="Default Workspace">
            <Input defaultValue="~/projects" mono />
          </Field>
        </Modal>
      </div>
    );
  },
};

export const DrawerDemo: StoryObj = {
  render: () => {
    const [open, setOpen] = useState(true);
    return (
      <div>
        <Button variant="secondary" onClick={() => setOpen(true)}>
          Open Drawer
        </Button>
        <Drawer
          open={open}
          onClose={() => setOpen(false)}
          title="tokens.css"
          subtitle="~/projects/super-harness/src/renderer/ui/tokens.css"
          icon={<FileCode2 className="w-4 h-4" />}
          headerActions={<Button size="xs" variant="subtle">Open in Cursor</Button>}
        >
          <pre className="p-4 text-caption font-mono text-ink-secondary">
            {`:root {\n  --sh-surface-rail: #111215;\n  --sh-surface-canvas: #16171b;\n}`}
          </pre>
        </Drawer>
      </div>
    );
  },
};
