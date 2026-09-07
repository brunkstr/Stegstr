import { useState, useEffect } from "react";
import * as Nostr from "./nostr-stub";
import { isWeb, pickImageFile } from "./platform-web";
import { MODES, MODE_LABELS, getStdmCapacityForFile, payloadBytes, type ModeName } from "./stego-stdm-web";
import { getDotCapacityForFile } from "./stego-dot-web";
import type { ProfileData } from "./types";

export type StegoMethod = "robust" | "dot";

export interface EmbedModalProps {
  onClose: () => void;
  onConfirm: () => void;
  embedding: boolean;
  stegoProgress: string;
  embedCoverFile: File | null;
  onCoverFileChange: (file: File | null) => void;
  recipientMode: "open" | "recipients";
  onRecipientModeChange: (mode: "open" | "recipients") => void;
  recipientInput: string;
  onRecipientInputChange: (value: string) => void;
  recipients: string[];
  onRecipientsChange: (recipients: string[]) => void;
  profiles: Record<string, ProfileData>;
  stegoMethod: StegoMethod;
  onStegoMethodChange: (method: StegoMethod) => void;
  stegoMode: ModeName;
  onStegoModeChange: (mode: ModeName) => void;
}

export function EmbedModal({
  onClose,
  onConfirm,
  embedding,
  stegoProgress,
  embedCoverFile,
  onCoverFileChange,
  recipientMode,
  onRecipientModeChange,
  recipientInput,
  onRecipientInputChange,
  recipients,
  onRecipientsChange,
  profiles,
  stegoMethod,
  onStegoMethodChange,
  stegoMode,
  onStegoModeChange,
}: EmbedModalProps) {
  const [capacityInfo, setCapacityInfo] = useState<string>("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    if (!embedCoverFile) {
      setCapacityInfo("");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        if (stegoMethod === "robust") {
          const info = await getStdmCapacityForFile(embedCoverFile, stegoMode);
          if (!cancelled) {
            setCapacityInfo(
              info.usable
                ? `Capacity: ${info.capacityBytes} bytes (${info.width}x${info.height})`
                : `Image too small for this mode: shortest edge is ${Math.min(info.width, info.height)}px, needs ${info.minEdge}px`,
            );
          }
        } else {
          const bytes = await getDotCapacityForFile(embedCoverFile);
          if (!cancelled) {
            setCapacityInfo(`Capacity: ~${Math.floor(bytes / 1024)} KB (PNG)`);
          }
        }
      } catch {
        if (!cancelled) setCapacityInfo("Could not compute capacity");
      }
    })();
    return () => { cancelled = true; };
  }, [embedCoverFile, stegoMethod, stegoMode]);

  const addRecipient = () => {
    const raw = recipientInput.trim();
    if (!raw) return;
    let pk = raw;
    if (raw.startsWith("npub")) {
      try {
        const d = Nostr.nip19.decode(raw);
        if (d.type === "npub") pk = Nostr.bytesToHex(d.data);
      } catch { return; }
    }
    if (/^[a-fA-F0-9]{64}$/.test(pk) && !recipients.includes(pk)) {
      onRecipientsChange([...recipients, pk]);
      onRecipientInputChange("");
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal embed-modal" onClick={(e) => e.stopPropagation()}>
        <h3>Embed feed into image</h3>
        <p className="muted">Data is encrypted so only Stegstr users can read it. DMs are encrypted for the recipient only.</p>

        {/* Cover image picker */}
        {isWeb() && (
          <div className="embed-cover-web" style={{ margin: "0.75rem 0" }}>
            <button
              type="button"
              className="btn-secondary"
              onClick={async () => {
                const file = await pickImageFile();
                if (file) onCoverFileChange(file);
              }}
            >
              {embedCoverFile ? embedCoverFile.name : "Choose cover image"}
            </button>
          </div>
        )}

        {/* Capacity info */}
        {capacityInfo && (
          <p className="muted" style={{ fontSize: "0.85rem" }}>{capacityInfo}</p>
        )}

        {/* Recipient mode */}
        <div className="embed-recipient-mode" style={{ margin: "0.75rem 0" }}>
          <label style={{ marginRight: "1rem" }}>
            <input type="radio" name="embed-mode" checked={recipientMode === "open"} onChange={() => onRecipientModeChange("open")} />
            {" "}Open (any Stegstr user)
          </label>
          <label>
            <input type="radio" name="embed-mode" checked={recipientMode === "recipients"} onChange={() => onRecipientModeChange("recipients")} />
            {" "}Recipients only
          </label>
        </div>
        {recipientMode === "recipients" && (
          <div className="embed-recipients" style={{ marginBottom: "0.75rem" }}>
            <div className="row" style={{ gap: "0.5rem", marginBottom: "0.25rem" }}>
              <input
                type="text"
                value={recipientInput}
                onChange={(e) => onRecipientInputChange(e.target.value)}
                placeholder="npub or hex pubkey"
                className="wide"
                style={{ flex: 1 }}
              />
              <button type="button" className="btn-secondary" onClick={addRecipient}>
                Add
              </button>
            </div>
            {recipients.length > 0 && (
              <ul style={{ listStyle: "none", padding: 0, margin: "0.25rem 0" }}>
                {recipients.map((pk) => (
                  <li key={pk} style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.85rem" }}>
                    <span>{profiles[pk]?.name ?? `${pk.slice(0, 12)}…`}</span>
                    <button type="button" className="btn-delete muted" style={{ fontSize: "0.75rem" }} onClick={() => onRecipientsChange(recipients.filter((p) => p !== pk))}>Remove</button>
                  </li>
                ))}
              </ul>
            )}
            {recipients.length === 0 && <p className="muted" style={{ fontSize: "0.85rem" }}>Add at least one recipient pubkey.</p>}
          </div>
        )}

        {/* Advanced options toggle */}
        <button
          type="button"
          className="btn-link muted"
          style={{ fontSize: "0.85rem", padding: 0, border: "none", background: "none", cursor: "pointer", textDecoration: "underline" }}
          onClick={() => setShowAdvanced(!showAdvanced)}
        >
          {showAdvanced ? "Hide advanced options" : "Advanced options"}
        </button>

        {showAdvanced && (
          <div className="embed-advanced" style={{ margin: "0.5rem 0", padding: "0.5rem", border: "1px solid #ddd", borderRadius: "4px" }}>
            {/* Stego method selector */}
            <div className="embed-method-selector">
              <label className="embed-section-label">Encoding method:</label>
              <div style={{ display: "flex", gap: "1rem" }}>
                <label style={{ cursor: "pointer" }}>
                  <input type="radio" name="stego-method" checked={stegoMethod === "robust"} onChange={() => onStegoMethodChange("robust")} />
                  {" "}Robust (JPEG, survives resizing)
                </label>
                <label style={{ cursor: "pointer" }}>
                  <input type="radio" name="stego-method" checked={stegoMethod === "dot"} onChange={() => onStegoMethodChange("dot")} />
                  {" "}Dot (PNG, legacy)
                </label>
              </div>
            </div>

            {/* How much to carry. There is no target-platform choice any more:
                the robust encoder normalises the image, so where it is going
                stops mattering. What still matters is payload size. */}
            {stegoMethod === "robust" && (
              <div className="embed-mode-selector" style={{ marginTop: "0.5rem" }}>
                <label className="embed-section-label">Payload size:</label>
                <select
                  value={stegoMode}
                  onChange={(e) => onStegoModeChange(e.target.value as ModeName)}
                >
                  {(Object.keys(MODES) as ModeName[]).map((key) => (
                    <option key={key} value={key}>
                      {MODE_LABELS[key].title} - {payloadBytes(MODES[key])} bytes
                    </option>
                  ))}
                </select>
                <p className="muted" style={{ fontSize: "0.8rem", marginTop: "0.25rem" }}>
                  {MODE_LABELS[stegoMode].detail}
                </p>
              </div>
            )}
          </div>
        )}

        {/* Progress indicator */}
        {embedding && (
          <div className="stego-progress" style={{ marginTop: "1rem" }}>
            <p className="muted detect-status">{stegoProgress || "Processing..."}</p>
            <div className="progress-bar"><div className="progress-bar-indeterminate"></div></div>
          </div>
        )}
        <div className="row modal-actions">
          <button type="button" onClick={onClose} disabled={embedding}>Cancel</button>
          <button type="button" onClick={onConfirm} className="btn-primary" disabled={embedding || (isWeb() && !embedCoverFile)}>
            {embedding ? "Embedding..." : "Embed"}
          </button>
        </div>
      </div>
    </div>
  );
}
