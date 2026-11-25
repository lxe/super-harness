import React, { useEffect, useState } from 'react';
import {
  Archive,
  Check,
  Columns2,
  Folder,
  GitBranch,
  MoreHorizontal,
  Pencil,
  Pin,
  RefreshCw,
  Terminal,
  Trash2,
  X,
} from 'lucide-react';
import type { OrganizeAction, SessionFolder, UnifiedSession } from '../../shared/types';
import {
  Button,
  IconButton,
  Input,
  MenuDivider,
  MenuItem,
  MenuSectionLabel,
  PopoverSurface,
} from '../ui';
import { formatRelativeTime, getHarnessVisual } from '../utils/format';
import { HarnessLogo } from './HarnessLogo';

export interface SessionHeaderProps {
  session: UnifiedSession;
  isMaster: boolean;
  subagents: UnifiedSession[];
  folders: SessionFolder[];
  viewMode: 'chat' | 'tmux';
  isSplitPane?: boolean;
  hasSplitOpen: boolean;
  onToggleViewMode: () => void;
  onSelectSession: (id: string) => void;
  onOrganize: (actions: OrganizeAction[]) => void;
  onReloadTranscript: () => void;
  onArchiveSession: (session: UnifiedSession, killTmux?: boolean) => void;
  onClearMaster: () => void;
  onOpenPath: (
    filePath: string,
    opts?: {
      startLine?: number;
      endLine?: number;
      mode?: 'auto' | 'internal' | 'editor' | 'file-manager' | 'terminal';
      tmuxSession?: string;
    }
  ) => void;
  onToggleSplit: () => void;
  onCloseSplit?: () => void;
}

/**
 * Single-line draggable session header: title & inline rename, nested subagents
 * switcher, tmux terminal mirror toggle, top-pin toggle, split-view control,
 * and overflow actions menu.
 */
export const SessionHeader: React.FC<SessionHeaderProps> = React.memo(
  ({
    session,
    isMaster,
    subagents,
    folders,
    viewMode,
    isSplitPane,
    hasSplitOpen,
    onToggleViewMode,
    onSelectSession,
    onOrganize,
    onReloadTranscript,
    onArchiveSession,
    onClearMaster,
    onOpenPath,
    onToggleSplit,
    onCloseSplit,
  }) => {
    const [menuOpen, setMenuOpen] = useState(false);
    const [subagentsOpen, setSubagentsOpen] = useState(false);
    const [editingTitle, setEditingTitle] = useState(false);
    const [titleDraft, setTitleDraft] = useState('');

    useEffect(() => {
      setMenuOpen(false);
      setSubagentsOpen(false);
      setEditingTitle(false);
    }, [session.id]);

    const saveTitle = () => {
      onOrganize([{ type: 'rename_session', sessionId: session.id, title: titleDraft }]);
      setEditingTitle(false);
    };

    const vis = getHarnessVisual(session.harness);

    return (
      <header className="sh-drag-region h-11 px-4 border-b border-line-hairline flex items-center justify-between gap-3 shrink-0 relative">
        <div className="flex items-center gap-2.5 min-w-0">
          {session.isSubagent && session.parentSessionId && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => onSelectSession(session.parentSessionId!)}
            >
              ← Parent
            </Button>
          )}
          {editingTitle ? (
            <div className="flex items-center gap-1">
              <Input
                autoFocus
                inputSize="sm"
                value={titleDraft}
                onChange={(e) => setTitleDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveTitle();
                  if (e.key === 'Escape') setEditingTitle(false);
                }}
                className="w-64"
              />
              <IconButton size="xs" label="Save title" onClick={saveTitle}>
                <Check className="w-3.5 h-3.5" />
              </IconButton>
            </div>
          ) : (
            <div className="flex items-center gap-2 min-w-0">
              <HarnessLogo harness={session.harness} size={15} />
              <h1 className="text-label font-medium text-ink-primary truncate">{session.title}</h1>
            </div>
          )}
          {!isMaster && <span className="text-micro text-ink-faint shrink-0">{vis.label}</span>}
        </div>

        <div className="flex items-center gap-1 shrink-0">
          {session.tmuxTarget && (
            <Button
              size="xs"
              variant={viewMode === 'tmux' ? 'secondary' : 'ghost'}
              onClick={onToggleViewMode}
              title={viewMode === 'tmux' ? 'Switch to Chat' : 'View live tmux terminal'}
              iconLeft={<Terminal className="w-3.5 h-3.5" />}
            >
              {viewMode === 'tmux' ? 'Chat' : 'Terminal'}
            </Button>
          )}

          {subagents.length > 0 && (
            <div className="relative">
              <Button
                size="xs"
                variant={subagentsOpen ? 'secondary' : 'ghost'}
                onClick={() => setSubagentsOpen((v) => !v)}
                iconLeft={<GitBranch className="w-3.5 h-3.5" />}
              >
                {subagents.length}
              </Button>

              {subagentsOpen && (
                <PopoverSurface
                  width="auto"
                  className="sh-no-drag absolute right-0 top-9 z-40 w-72 space-y-1"
                >
                  <div className="px-2 py-1 text-micro font-medium text-ink-muted flex items-center justify-between">
                    <span>Subagents ({subagents.length})</span>
                    <span className="text-micro text-ink-faint">Nested & archived</span>
                  </div>
                  <div className="max-h-64 overflow-y-auto space-y-0.5">
                    {subagents.map((sub) => (
                      <MenuItem
                        key={sub.id}
                        onClick={() => {
                          setSubagentsOpen(false);
                          onSelectSession(sub.id);
                        }}
                        rightSlot={
                          <span className="text-micro">
                            {sub.status === 'running'
                              ? 'running'
                              : formatRelativeTime(sub.updatedAt)}
                          </span>
                        }
                      >
                        {sub.title}
                      </MenuItem>
                    ))}
                  </div>
                </PopoverSurface>
              )}
            </div>
          )}

          {!isMaster && (
            <IconButton
              label={
                session.pinnedToTop ? 'Unpin from Super Harness top' : 'Pin to Super Harness top'
              }
              tone={session.pinnedToTop ? 'warning' : 'default'}
              onClick={() =>
                onOrganize([
                  {
                    type: session.pinnedToTop ? 'unpin_top' : 'pin_top',
                    sessionId: session.id,
                  },
                ])
              }
              className={
                session.pinnedToTop ? 'bg-amber-400/10 hover:bg-amber-400/15' : undefined
              }
            >
              <Pin className="w-3.5 h-3.5" />
            </IconButton>
          )}

          {isSplitPane ? (
            <IconButton label="Close split" onClick={onCloseSplit}>
              <X className="w-3.5 h-3.5" />
            </IconButton>
          ) : (
            <IconButton label="Split view (Ctrl+\)" active={hasSplitOpen} onClick={onToggleSplit}>
              <Columns2 className="w-3.5 h-3.5" />
            </IconButton>
          )}

          <div className="relative">
            <IconButton label="More options" active={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
              <MoreHorizontal className="w-4 h-4" />
            </IconButton>

            {menuOpen && (
              <PopoverSurface
                width="sm"
                className="sh-no-drag absolute right-0 top-9 z-40 w-52 space-y-0.5"
              >
                {!isMaster && (
                  <>
                    <MenuItem
                      icon={<Pencil className="w-3.5 h-3.5" />}
                      onClick={() => {
                        setTitleDraft(session.title);
                        setEditingTitle(true);
                        setMenuOpen(false);
                      }}
                    >
                      Rename
                    </MenuItem>
                    <MenuItem
                      icon={
                        <Pin
                          className={`w-3.5 h-3.5 ${
                            session.pinnedToTop ? 'text-amber-400' : 'text-ink-muted'
                          }`}
                        />
                      }
                      onClick={() => {
                        onOrganize([
                          {
                            type: session.pinnedToTop ? 'unpin_top' : 'pin_top',
                            sessionId: session.id,
                          },
                        ]);
                        setMenuOpen(false);
                      }}
                    >
                      {session.pinnedToTop ? 'Unpin from top' : 'Pin to Super Harness top'}
                    </MenuItem>
                    {folders.length > 0 && (
                      <>
                        <MenuDivider />
                        <MenuSectionLabel>Move to folder</MenuSectionLabel>
                        <MenuItem
                          active={!session.folderId}
                          onClick={() => {
                            onOrganize([
                              { type: 'assign_folder', sessionId: session.id, folderId: null },
                            ]);
                            setMenuOpen(false);
                          }}
                        >
                          None
                        </MenuItem>
                        {folders.map((f) => (
                          <MenuItem
                            key={f.id}
                            active={session.folderId === f.id}
                            icon={<Folder className="w-3 h-3" />}
                            onClick={() => {
                              onOrganize([
                                { type: 'assign_folder', sessionId: session.id, folderId: f.id },
                              ]);
                              setMenuOpen(false);
                            }}
                          >
                            {f.name}
                          </MenuItem>
                        ))}
                      </>
                    )}
                    <MenuDivider />
                    <MenuItem
                      icon={<RefreshCw className="w-3.5 h-3.5" />}
                      onClick={() => {
                        onReloadTranscript();
                        setMenuOpen(false);
                      }}
                    >
                      Reload transcript
                    </MenuItem>
                    <MenuItem
                      tone="warning"
                      icon={<Archive className="w-3.5 h-3.5" />}
                      onClick={() => {
                        onArchiveSession(session, false);
                        setMenuOpen(false);
                      }}
                    >
                      Archive
                    </MenuItem>
                  </>
                )}
                {isMaster && (
                  <MenuItem
                    tone="danger"
                    icon={<Trash2 className="w-3.5 h-3.5" />}
                    onClick={() => {
                      onClearMaster();
                      setMenuOpen(false);
                    }}
                  >
                    Clear history
                  </MenuItem>
                )}
                <MenuDivider />
                <MenuItem
                  icon={<Terminal className="w-3.5 h-3.5" />}
                  onClick={() => {
                    onOpenPath(session.cwd, {
                      mode: 'terminal',
                      tmuxSession: session.tmuxSessionName,
                    });
                    setMenuOpen(false);
                  }}
                >
                  {session.tmuxSessionName
                    ? 'Attach in Default Terminal'
                    : 'Open in Default Terminal'}
                </MenuItem>
                <MenuItem
                  icon={<Folder className="w-3.5 h-3.5" />}
                  onClick={() => {
                    onOpenPath(session.cwd, { mode: 'file-manager' });
                    setMenuOpen(false);
                  }}
                >
                  Open Folder
                </MenuItem>
                <MenuItem
                  icon={<Pencil className="w-3.5 h-3.5" />}
                  onClick={() => {
                    onOpenPath(session.cwd, { mode: 'editor' });
                    setMenuOpen(false);
                  }}
                >
                  Open Workspace in Editor
                </MenuItem>
                <div className="border-t border-line-hairline mt-1 pt-1.5 px-2.5 py-1 text-micro font-mono text-ink-faint break-all">
                  {session.cwd}
                </div>
              </PopoverSurface>
            )}
          </div>
        </div>
      </header>
    );
  }
);
