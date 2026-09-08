import { useState } from "react";
import * as Nostr from "./nostr-stub";
import type { IdentityEntry, ProfileData } from "./types";
import type { WalletApi } from "./app/useWallet";

export interface SettingsViewProps {
  identities: IdentityEntry[];
  profiles: Record<string, ProfileData>;
  relayUrls: string[];
  setRelayUrls: React.Dispatch<React.SetStateAction<string[]>>;
  newRelayUrl: string;
  setNewRelayUrl: React.Dispatch<React.SetStateAction<string>>;
  muteInput: string;
  setMuteInput: React.Dispatch<React.SetStateAction<string>>;
  mutedPubkeys: Set<string>;
  setMutedPubkeys: React.Dispatch<React.SetStateAction<Set<string>>>;
  mutedWords: string[];
  setMutedWords: React.Dispatch<React.SetStateAction<string[]>>;
  resolvePubkeyFromInput: (input: string) => string | null;
  onStatus: (msg: string) => void;
  /** Publicity-contest referral code currently stored (null when none or expired). */
  referralCode: string | null;
  /** Store a new code (any form: bare, URL) or clear it with null. Returns the canonical code or null. */
  setReferralCode: (input: string | null) => string | null;
  /** Lightning wallet (Nostr Wallet Connect). */
  wallet: WalletApi;
}

export function SettingsView({
  identities, profiles, relayUrls, setRelayUrls, newRelayUrl, setNewRelayUrl,
  muteInput, setMuteInput, mutedPubkeys, setMutedPubkeys, mutedWords, setMutedWords,
  resolvePubkeyFromInput, onStatus, referralCode, setReferralCode, wallet,
}: SettingsViewProps) {
  const [nwcInput, setNwcInput] = useState("");
  const [zapInput, setZapInput] = useState(String(wallet.zapSats));
  const handleConnectWallet = async () => {
    if (!nwcInput.trim()) return;
    const ok = await wallet.connect(nwcInput.trim());
    if (ok) setNwcInput("");
  };
  const [referralInput, setReferralInput] = useState("");
  const handleSaveReferral = () => {
    if (!referralInput.trim()) return;
    const code = setReferralCode(referralInput);
    if (code) {
      setReferralInput("");
      onStatus(`Referral code ${code} saved.`);
    } else {
      onStatus("That is not a valid referral code (4-8 letters/digits, no 0, O, 1, I or L).");
    }
  };
  const handleAddRelay = () => {
    if (newRelayUrl.trim()) {
      const url = newRelayUrl.trim().toLowerCase();
      if (url.startsWith("wss://") || url.startsWith("ws://")) {
        if (relayUrls.includes(url)) {
          onStatus("Relay already added.");
        } else {
          setRelayUrls((prev) => [...prev, url]);
          onStatus("Relay added.");
        }
        setNewRelayUrl("");
      } else {
        onStatus("Relay URL must start with wss:// or ws://");
      }
    }
  };

  const handleAddMute = () => {
    const pk = resolvePubkeyFromInput(muteInput.trim());
    if (pk) {
      setMutedPubkeys((prev) => new Set(prev).add(pk));
      setMuteInput("");
    } else if (muteInput.trim()) {
      setMutedWords((prev) => prev.includes(muteInput.trim().toLowerCase()) ? prev : [...prev, muteInput.trim().toLowerCase()]);
      setMuteInput("");
    }
  };

  return (
    <section className="settings-view">
      <h2>Settings</h2>
      <h3 className="settings-section">
        Identities
        <span className="info-icon" tabIndex={0} data-tooltip="Public keys (npub) are safe to share. Secret keys (nsec) should never be shared.">ⓘ</span>
      </h3>
      <p className="muted">Public keys (npub). Click to copy.</p>
      <ul className="settings-list">
        {identities.map((id) => {
          const pk = Nostr.getPublicKey(Nostr.hexToBytes(id.privKeyHex));
          const label = profiles[pk]?.name || id.label || pk.slice(0, 8) + "…";
          return (
            <li key={id.id} className="settings-list-item settings-identity-item">
              <span className="muted">{label}</span>
              <span
                className="pubkey-copy muted"
                style={{ fontFamily: "monospace", fontSize: "0.8rem", wordBreak: "break-all" }}
                title="Click to copy npub"
                onClick={async () => {
                  const npub = Nostr.nip19.npubEncode(pk);
                  await navigator.clipboard.writeText(npub);
                  onStatus("Copied!");
                  setTimeout(() => onStatus(""), 1500);
                }}
              >
                {Nostr.nip19.npubEncode(pk)}
              </span>
            </li>
          );
        })}
      </ul>
      <h3 className="settings-section">
        Lightning wallet
        <span className="info-icon" tabIndex={0} data-tooltip="Nostr Wallet Connect lets Stegstr pay and create Lightning invoices through a wallet you already have. The wallet keeps the money and its own spending limit; Stegstr only keeps the connection string.">ⓘ</span>
      </h3>
      {wallet.connected ? (
        <>
          <div className="wallet-status">
            <span className="ok">Connected{wallet.alias ? `: ${wallet.alias}` : ""}</span>
            <span className="muted">{wallet.balanceSat === null ? "balance unknown" : `${wallet.balanceSat.toLocaleString()} sats`}</span>
            {wallet.lud16 && <span className="muted">receive at {wallet.lud16}</span>}
            <button type="button" className="btn-secondary" onClick={() => void wallet.refreshBalance()}>Refresh</button>
            <button type="button" className="btn-delete muted" onClick={wallet.disconnect}>Disconnect</button>
          </div>
          {wallet.error && <p className="muted" style={{ color: "#c33" }}>{wallet.error}</p>}
        </>
      ) : (
        <>
          <p className="muted">Paste a connection string from a wallet that supports Nostr Wallet Connect (Alby Hub, Coinos, Primal, Zeus and others). It starts with <code>nostr+walletconnect://</code>. Give it a spending limit in the wallet.</p>
          <div className="mute-add-wrap">
            <input
              type="password"
              value={nwcInput}
              onChange={(e) => setNwcInput(e.target.value)}
              placeholder="nostr+walletconnect://…"
              aria-label="Wallet connection string"
              autoComplete="off"
              onKeyDown={(e) => { if (e.key === "Enter" && nwcInput.trim()) void handleConnectWallet(); }}
            />
            <button type="button" className="btn-secondary" onClick={() => void handleConnectWallet()} disabled={!nwcInput.trim() || wallet.status === "connecting"}>
              {wallet.status === "connecting" ? "Connecting…" : "Connect"}
            </button>
          </div>
          {wallet.status === "error" && wallet.error && <p className="muted" style={{ color: "#c33" }}>{wallet.error}</p>}
        </>
      )}
      <div className="wallet-status">
        <label className="muted" htmlFor="zap-sats">Zap amount</label>
        <input id="zap-sats" type="number" min={1} step={1} value={zapInput} onChange={(e) => setZapInput(e.target.value)} onBlur={() => { const n = Number(zapInput); if (Number.isInteger(n) && n > 0) wallet.setZapSats(n); else setZapInput(String(wallet.zapSats)); }} style={{ width: "6rem" }} />
        <span className="muted">sats per zap, paid through the wallet when the author has a Lightning address</span>
      </div>
      <p className="muted">Ecash: notes can carry Cashu tokens. With a wallet connected you can redeem them straight into it; without one, copy the token into a Cashu wallet such as cashu.me or Minibits.</p>
      <h3 className="settings-section">
        Referral code
        <span className="info-icon" tabIndex={0} data-tooltip="If someone invited you to Stegstr with a link or QR code, enter their code here so their invitation counts in the publicity contest.">ⓘ</span>
      </h3>
      <p className="muted">
        {referralCode
          ? <>Your profile and notes carry referral code <code>{referralCode}</code> for 30 days. Nothing else is shared.</>
          : <>Came here through someone's stegstr.com/r/… link or QR code? Enter their code so it counts for them. Optional.</>}
      </p>
      <div className="mute-add-wrap">
        <input
          type="text"
          value={referralInput}
          onChange={(e) => setReferralInput(e.target.value)}
          placeholder={referralCode ? "Replace code" : "Code or link, e.g. K7M2QX"}
          aria-label="Referral code"
          onKeyDown={(e) => { if (e.key === "Enter" && referralInput.trim()) handleSaveReferral(); }}
        />
        <button type="button" className="btn-secondary" onClick={handleSaveReferral} disabled={!referralInput.trim()}>Save</button>
        {referralCode && (
          <button type="button" className="btn-delete muted" onClick={() => { setReferralCode(null); onStatus("Referral code removed."); }}>Remove</button>
        )}
      </div>
      <h3 className="settings-section">
        Relays
        <span className="info-icon" tabIndex={0} data-tooltip="Relays are Nostr servers that store and deliver events. Add your favorites here.">ⓘ</span>
      </h3>
      <p className="muted">Default is the Stegstr relay (proxy); relay path is managed by Stegstr. You can add or remove relay URLs below.</p>
      <div className="mute-add-wrap">
        <input
          type="url"
          placeholder="wss://…"
          value={newRelayUrl}
          onChange={(e) => setNewRelayUrl(e.target.value)}
          className="wide"
          onKeyDown={(e) => { if (e.key === "Enter" && newRelayUrl.trim()) handleAddRelay(); }}
        />
        <button type="button" className="btn-secondary" onClick={handleAddRelay}>Add</button>
      </div>
      <ul className="settings-list">
        {relayUrls.map((url) => (
          <li key={url} className="settings-list-item">
            <span className="muted" style={{ wordBreak: "break-all" }}>{url}</span>
            <button type="button" className="btn-delete muted" disabled={relayUrls.length <= 1} title={relayUrls.length <= 1 ? "Cannot remove last relay" : "Remove"} onClick={() => setRelayUrls((prev) => prev.filter((u) => u !== url))}>Remove</button>
          </li>
        ))}
      </ul>
      {relayUrls.length === 0 && <p className="muted">Add at least one relay (e.g. the Stegstr proxy or wss://relay.damus.io).</p>}
      <h3 className="settings-section">Mute</h3>
      <p className="muted">Muted users and words are hidden from feed and notifications.</p>
      <div className="mute-add-wrap">
        <input
          type="text"
          placeholder="npub / hex pubkey or word…"
          value={muteInput}
          onChange={(e) => setMuteInput(e.target.value)}
          className="wide"
          onKeyDown={(e) => { if (e.key === "Enter") handleAddMute(); }}
        />
        <button type="button" className="btn-secondary" onClick={handleAddMute}>Add</button>
      </div>
      {mutedPubkeys.size > 0 && (
        <>
          <p className="settings-sub">Muted users</p>
          <ul className="settings-list">
            {[...mutedPubkeys].map((pk) => (
              <li key={pk} className="settings-list-item">
                <span className="muted">{pk.slice(0, 12)}…{pk.slice(-6)}</span>
                <button type="button" className="btn-delete muted" onClick={() => setMutedPubkeys((prev) => { const s = new Set(prev); s.delete(pk); return s; })}>Remove</button>
              </li>
            ))}
          </ul>
        </>
      )}
      {mutedWords.length > 0 && (
        <>
          <p className="settings-sub">Muted words</p>
          <ul className="settings-list">
            {mutedWords.map((w) => (
              <li key={w} className="settings-list-item">
                <span className="muted">{w}</span>
                <button type="button" className="btn-delete muted" onClick={() => setMutedWords((prev) => prev.filter((x) => x !== w))}>Remove</button>
              </li>
            ))}
          </ul>
        </>
      )}
      <h3 className="settings-section">Stego</h3>
      <p className="muted">Detect: load image to extract Nostr state. Embed: save current feed to image. When Network is OFF, use images to pass state P2P. Turn Network ON to sync local changes to relays.</p>
      <p className="muted" style={{ marginTop: "0.5rem" }}>Stegstr 0.1.0</p>
    </section>
  );
}
