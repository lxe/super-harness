import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, Smartphone } from 'lucide-react';
import type {
  MobileAccessInfo,
  MobileAddress,
  MobileApiSettings,
  PairingSession,
  SuperHarnessSettings,
} from '../../shared/types';
import { Badge, Button, IconButton, Input, Modal, SettingsGroup, SettingsRow, Switch } from '../ui';
import { formatRelativeTime } from '../utils/format';

interface Props {
  settings: SuperHarnessSettings;
  onUpdateSettings: (patch: Partial<SuperHarnessSettings>) => void;
}

type PairingPanel =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'open'; session: PairingSession }
  | { kind: 'paired'; deviceName: string }
  | { kind: 'ended'; message: string };

const ADDRESS_LABEL: Record<MobileAddress['kind'], string> = {
  'tailscale-dns': 'Tailscale name',
  'tailscale-ip': 'Tailscale IP',
  lan: 'Local network',
};

function formatCountdown(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function formatDate(ts: number): string {
  try {
    return new Date(ts).toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  } catch {
    return '';
  }
}

/** Settings → Mobile: phone access, addresses, QR pairing and paired devices. */
export const MobileSettingsPane: React.FC<Props> = ({ settings, onUpdateSettings }) => {
  const mobile: MobileApiSettings = settings.mobileApi ?? {
    enabled: false,
    bindHost: '0.0.0.0',
    port: 47890,
    token: '',
  };
  const updateMobile = (patch: Partial<MobileApiSettings>) => {
    const { pairedDevices: _pd, hostId: _hid, ...editableMobile } = mobile;
    onUpdateSettings({ mobileApi: { ...editableMobile, ...patch } });
  };

  const [info, setInfo] = useState<MobileAccessInfo | null>(null);
  const [portDraft, setPortDraft] = useState(String(mobile.port ?? 47890));
  const [nameDraft, setNameDraft] = useState(mobile.hostName ?? '');
  const [panel, setPanel] = useState<PairingPanel>({ kind: 'idle' });
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = useState<{ id: string; name: string } | null>(null);
  const panelRef = useRef(panel);
  const pairAreaRef = useRef<HTMLDivElement | null>(null);
  panelRef.current = panel;

  const refreshInfo = useCallback(() => {
    void window.superHarness.getMobileAccessInfo().then(setInfo);
  }, []);

  // Re-read addresses and the listening port when access, port or name change.
  useEffect(() => {
    const t = setTimeout(refreshInfo, 300);
    return () => clearTimeout(t);
  }, [refreshInfo, mobile.enabled, mobile.port, mobile.hostName]);

  useEffect(() => setPortDraft(String(mobile.port ?? 47890)), [mobile.port]);
  useEffect(() => setNameDraft(mobile.hostName ?? ''), [mobile.hostName]);

  useEffect(
    () =>
      window.superHarness.onPairingEvent((ev) => {
        if (ev.type === 'paired') {
          setPanel({ kind: 'paired', deviceName: ev.device.name });
        } else if (ev.reason === 'expired' || ev.reason === 'too_many_attempts') {
          if (panelRef.current.kind === 'open') {
            setPanel({
              kind: 'ended',
              message:
                ev.reason === 'expired'
                  ? 'The code expired.'
                  : 'Too many wrong codes were entered, so this code no longer works.',
            });
          }
        }
      }),
    []
  );

  // "Paired with …" closes itself.
  useEffect(() => {
    if (panel.kind !== 'paired') return;
    const t = setTimeout(() => setPanel({ kind: 'idle' }), 4000);
    return () => clearTimeout(t);
  }, [panel.kind]);

  useEffect(() => {
    if (panel.kind !== 'open') return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [panel.kind]);

  // Leaving Settings ends an unfinished pairing.
  useEffect(
    () => () => {
      if (panelRef.current.kind === 'open') void window.superHarness.closePairing();
    },
    []
  );

  // Turning access off ends pairing too.
  useEffect(() => {
    if (!mobile.enabled && panelRef.current.kind === 'open') {
      void window.superHarness.closePairing();
      setPanel({ kind: 'idle' });
    }
  }, [mobile.enabled]);

  // Esc closes only the Revoke confirmation, not Settings behind it.
  useEffect(() => {
    if (!revokeTarget) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setRevokeTarget(null);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [revokeTarget]);

  const confirmRevoke = () => {
    if (revokeTarget) void window.superHarness.revokePairedDevice(revokeTarget.id);
    setRevokeTarget(null);
  };

  const startPairing = async () => {
    setPanel({ kind: 'loading' });
    const res = await window.superHarness.openPairing();
    if ('error' in res) {
      setPanel({ kind: 'ended', message: res.error });
      return;
    }
    setNow(Date.now());
    setPanel({ kind: 'open', session: res });
    requestAnimationFrame(() =>
      pairAreaRef.current?.scrollIntoView({
        block: 'nearest',
        behavior: 'smooth',
      })
    );
  };

  const cancelPairing = () => {
    void window.superHarness.closePairing();
    setPanel({ kind: 'idle' });
  };

  const commitPort = () => {
    const parsed = Number(portDraft.replace(/[^0-9]/g, ''));
    if (parsed >= 1024 && parsed <= 65535) {
      if (parsed !== mobile.port) updateMobile({ port: parsed });
    } else {
      setPortDraft(String(mobile.port ?? 47890));
    }
  };

  const commitName = () => {
    const next = nameDraft.trim();
    if (next !== (mobile.hostName ?? '')) updateMobile({ hostName: next });
  };

  const copy = (text: string) => {
    void navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied((c) => (c === text ? null : c)), 1400);
  };

  const devices = [...(mobile.pairedDevices ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  const listening = Boolean(info?.listeningPort);
  const notListeningReason =
    mobile.enabled && info && !listening
      ? `Port ${mobile.port} is unavailable. Another app may be using it.`
      : null;

  return (
    <div className="space-y-7">
      <SettingsGroup title="Phone access">
        <SettingsRow
          label="Allow phones to connect"
          description="Lets the Super Harness iPhone app reach this desktop. Phones need to pair first."
          control={<Switch checked={mobile.enabled} onChange={(enabled) => updateMobile({ enabled })} />}
        />
      </SettingsGroup>

      <div ref={pairAreaRef}>
        <SettingsGroup title="Pair a phone">
          {panel.kind === 'open' ? (
            <div className="py-5 flex items-start gap-6">
              <img
                src={panel.session.qrDataUrl}
                alt="Pairing QR code"
                width={180}
                height={180}
                className="w-[180px] h-[180px] rounded-xl bg-white p-2 shrink-0"
                style={{ imageRendering: 'pixelated' }}
              />
              <div className="min-w-0 space-y-3 pt-1">
                <p className="text-body text-ink-primary leading-snug">
                  Open Super Harness on your iPhone and scan this code.
                </p>
                <div className="space-y-1">
                  <div className="text-caption text-ink-muted">Or enter this code:</div>
                  <div className="font-mono text-[26px] leading-none tracking-[0.18em] text-ink-primary tabular-nums select-text">
                    {panel.session.code.slice(0, 3)} {panel.session.code.slice(3)}
                  </div>
                </div>
                <div className="text-caption text-ink-faint tabular-nums">
                  Expires in {formatCountdown(panel.session.expiresAt - now)}
                </div>
                <Button size="sm" variant="secondary" onClick={cancelPairing}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : panel.kind === 'paired' ? (
            <div className="py-4 flex items-center gap-2.5 text-body text-ink-primary">
              <Check className="w-4 h-4 text-emerald-400 shrink-0" />
              Paired with {panel.deviceName}
            </div>
          ) : (
            <SettingsRow
              label={panel.kind === 'ended' ? panel.message : 'Show a QR code to scan'}
              description={
                !mobile.enabled
                  ? 'Turn on “Allow phones to connect” first.'
                  : (notListeningReason ?? 'The code works once and expires after 10 minutes.')
              }
              control={
                <Button
                  size="sm"
                  variant="secondary"
                  iconLeft={<Smartphone className="w-3.5 h-3.5" />}
                  loading={panel.kind === 'loading'}
                  disabled={!mobile.enabled || !listening || panel.kind === 'loading'}
                  onClick={() => void startPairing()}
                >
                  {panel.kind === 'ended' ? 'New code' : 'Pair a phone'}
                </Button>
              }
            />
          )}
        </SettingsGroup>
      </div>

      <SettingsGroup title="Paired devices">
        {devices.length === 0 ? (
          <div className="py-4 text-caption text-ink-muted">No phones paired yet.</div>
        ) : (
          devices.map((d) => (
            <SettingsRow
              key={d.id}
              label={d.name}
              description={`Paired ${formatDate(d.createdAt)}${
                d.lastSeenAt
                  ? ` · last seen ${formatRelativeTime(d.lastSeenAt) === 'now' ? 'just now' : `${formatRelativeTime(d.lastSeenAt)} ago`}`
                  : ''
              }`}
              control={
                <Button
                  size="xs"
                  variant="danger"
                  onClick={() => setRevokeTarget({ id: d.id, name: d.name })}
                >
                  Revoke
                </Button>
              }
            />
          ))
        )}
      </SettingsGroup>

      {mobile.enabled && (
        <SettingsGroup
          title="Network"
          description="Pairing works when your phone and this desktop are on the same network. Tailscale on both works best: it connects from anywhere and is encrypted."
        >
          {info && info.addresses.length === 0 && (
            <div className="py-4 text-caption text-ink-muted">No network addresses found.</div>
          )}
          {info?.addresses.map((a) => (
            <div key={a.address} className="py-3 flex items-center justify-between gap-4">
              <div className="min-w-0 flex items-center gap-2.5">
                <span className="font-mono text-caption text-ink-primary truncate">{a.address}</span>
                <Badge tone={a.kind === 'lan' ? 'neutral' : 'accent'}>{ADDRESS_LABEL[a.kind]}</Badge>
              </div>
              <IconButton
                label={`Copy ${a.address}`}
                onClick={() => copy(`${a.address}:${info.listeningPort || mobile.port}`)}
              >
                {copied === `${a.address}:${info.listeningPort || mobile.port}` ? (
                  <Check className="w-3.5 h-3.5" />
                ) : (
                  <Copy className="w-3.5 h-3.5" />
                )}
              </IconButton>
            </div>
          ))}
          {info && !info.addresses.some((a) => a.kind !== 'lan') && (
            <div className="py-3 text-caption text-ink-faint">
              Tailscale isn’t running on this desktop, so phones can connect only from the same network.
            </div>
          )}
          <SettingsRow
            label="Desktop name"
            description="Shown on your phone when pairing and in its list of nearby desktops"
            control={
              <Input
                inputSize="sm"
                className="w-56"
                value={nameDraft}
                placeholder={info?.defaultHostName ?? 'This computer'}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={commitName}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              />
            }
          />
          <SettingsRow
            label="Port"
            description={notListeningReason ?? 'Phones connect to this port on any of the addresses below'}
            control={
              <Input
                inputSize="sm"
                mono
                className="w-28 text-right"
                value={portDraft}
                onChange={(e) => setPortDraft(e.target.value)}
                onBlur={commitPort}
                onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              />
            }
          />
        </SettingsGroup>
      )}

      {revokeTarget && (
        <Modal
          onClose={() => setRevokeTarget(null)}
          title={`Revoke ${revokeTarget.name}?`}
          width="sm"
          footer={
            <>
              <Button variant="ghost" onClick={() => setRevokeTarget(null)}>
                Cancel
              </Button>
              <Button variant="danger" onClick={confirmRevoke}>
                Revoke
              </Button>
            </>
          }
        >
          <p className="text-body text-ink-secondary">
            It will need to pair again. The phone is disconnected right away.
          </p>
        </Modal>
      )}
    </div>
  );
};
