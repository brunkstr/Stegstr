/** Extracted verbatim from App.tsx (merge plan step 2). Outer state arrives via `deps`; nothing else changed. */
import { useState, useCallback, useEffect, type Dispatch, type SetStateAction } from "react";
import * as Nostr from "../nostr-stub";
import { isWeb, pickImageFile, encodeStegoToBlob, downloadBlob } from "../platform-web";
import { decodeAny } from "../codecs/registry";
import { MODES, payloadBytes as stdmPayloadBytes, type ModeName, encodeStdmImageFile, getStdmCapacityForFile, stdmSelfTest } from "../stego-stdm-web";
import { getDotCapacityForFile } from "../stego-dot-web";
import { getTauri } from "../platform-desktop";
import { uint8ArrayToBase64 } from "../utils";
import * as stegoCrypto from "../stego-crypto";
import * as logger from "../logger";
import type { StegoMethod } from "../EmbedModal";
import type { IdentityEntry, NostrEvent, NostrStateBundle, ProfileData, View } from "../types";
import { STEGSTR_BUNDLE_VERSION } from "./storage";

import { encodeQimImageFile, resizeCoverForPlatform, qimSelfTest, getQimCapacityForFile, PLATFORM_WIDTHS, DEFAULT_PLATFORM } from "../stego-qim";

export interface StegoDeps {
  profile: string | null;
  events: NostrEvent[];
  setEvents: Dispatch<SetStateAction<NostrEvent[]>>;
  profiles: Record<string, ProfileData>;
  setProfiles: Dispatch<SetStateAction<Record<string, ProfileData>>>;
  identities: IdentityEntry[];
  viewingPubkeys: Set<string>;
  effectivePrivKey: string;
  setStatus: Dispatch<SetStateAction<string>>;
  setView: Dispatch<SetStateAction<View>>;
  setSearchQuery: Dispatch<SetStateAction<string>>;
  setFeedFilter: Dispatch<SetStateAction<"global" | "following">>;
}

export function useStego(deps: StegoDeps) {
  const { effectivePrivKey, events, identities, profile, profiles, setEvents, setFeedFilter, setProfiles, setSearchQuery, setStatus, setView, viewingPubkeys } = deps;

  const [decodeError, setDecodeError] = useState<string>("");

  const [embedModalOpen, setEmbedModalOpen] = useState(false);

  const [embedMethod, setEmbedMethod] = useState<StegoMethod>("robust");
  const [stegoMode, setStegoMode] = useState<ModeName>("standard");

  const [targetPlatform, setTargetPlatform] = useState<string>("instagram");

  const [embedCoverFile, setEmbedCoverFile] = useState<File | null>(null);

  const [embedRecipientMode, setEmbedRecipientMode] = useState<"open" | "recipients">("open");

  const [embedRecipientInput, setEmbedRecipientInput] = useState("");

  const [embedRecipients, setEmbedRecipients] = useState<string[]>([]);

  const [importedEventIds, setImportedEventIds] = useState<Set<string>>(() => new Set());

  const [detecting, setDetecting] = useState(false);

  const [embedding, setEmbedding] = useState(false);

  const [stegoProgress, setStegoProgress] = useState("");

  const [stegoLogs, setStegoLogs] = useState<string[]>([]);

  const [dragOverStego, setDragOverStego] = useState(false);

  const addStegoLog = useCallback((msg: string) => {
    const ts = new Date().toLocaleTimeString();
    setStegoLogs(prev => [...prev.slice(-19), `[${ts}] ${msg}`]);
    console.log("[StegoLog]", msg);
  }, []);

  const handleLoadFromImage = useCallback(async (providedPathOrFile?: string | File | null) => {
    setDecodeError("");
    setStegoLogs([]);
    if (isWeb()) {
      let file: File | null;
      if (providedPathOrFile instanceof File) {
        file = providedPathOrFile;
        addStegoLog(`Dropped file: ${file.name}`);
      } else if (providedPathOrFile !== undefined && providedPathOrFile !== null) {
        return;
      } else {
        setDetecting(true);
        addStegoLog("Opening file picker...");
        try {
          file = await pickImageFile();
        } finally {
          setDetecting(false);
        }
      }
      if (!file) {
        setStatus("Cancelled");
        addStegoLog("File picker cancelled");
        logger.logAction("detect_cancelled", "User cancelled file picker");
        return;
      }
      setDetecting(true);
      setStegoProgress("Reading image file...");
      addStegoLog(`Selected: ${file.name} (${file.size} bytes, type: ${file.type})`);
      logger.logAction("detect_started", "Decoding stego image (browser)", { name: file.name });
      try {
      // Every registered codec that accepts this file is tried in registry order
      // (robust JPEG codecs first, the lossless Dot method last). Each codec
      // verifies its own payload, so a false positive cannot shadow another.
      setStegoProgress("Extracting hidden data...");
      const result = await decodeAny(file, (line) => {
        addStegoLog(line);
        setStegoProgress(line);
      });
      if (result.ok) addStegoLog(`Decoded with ${result.codecId}`);
      if (!result.ok || !result.payload) {
        const err = result.error || "Decode failed";
        addStegoLog(`FAIL: ${err}`);
        setDecodeError(err);
        logger.logAction("detect_error", err, { name: file.name });
        return;
      }
      addStegoLog(`Decode OK! Payload: ${result.payload.length} chars`);
        const raw = result.payload;
        console.log("[App] Detected payload type:", raw.startsWith("base64:") ? "base64" : "json", "len:", raw.length);
        let jsonString: string;
        if (raw.startsWith("base64:")) {
          addStegoLog("Decoding base64 payload...");
          const bytes = Uint8Array.from(atob(raw.slice(7)), (c) => c.charCodeAt(0));
          addStegoLog(`Decoded: ${bytes.length} bytes, prefix: ${String.fromCharCode(...bytes.slice(0, 8))}`);
          console.log("[App] Decoded bytes len:", bytes.length, "first 16:", Array.from(bytes.slice(0, 16)));
          console.log("[App] First 8 as string:", String.fromCharCode(...bytes.slice(0, 8)));
          if (!stegoCrypto.isEncryptedPayload(bytes)) {
            addStegoLog("FAIL: Missing STEGSTR1 magic header!");
            console.log("[App] FAIL: bytes don't start with STEGSTR1. Expected:", Array.from(new TextEncoder().encode("STEGSTR1")));
            setDecodeError("Not a Stegstr encrypted image");
            logger.logAction("detect_error", "Not a Stegstr encrypted image", { name: file.name });
            return;
          }
          addStegoLog("STEGSTR1 header found! Decrypting...");
          let keysToTry = identities
            .filter((i) => viewingPubkeys.has(Nostr.getPublicKey(Nostr.hexToBytes(i.privKeyHex))))
            .map((i) => i.privKeyHex);
          if (keysToTry.length === 0) keysToTry = [effectivePrivKey];
          addStegoLog(`Trying ${keysToTry.length} keys...`);
          let lastErr: Error | null = null;
          jsonString = "";
          for (let ki = 0; ki < keysToTry.length; ki++) {
            const key = keysToTry[ki];
            try {
              addStegoLog(`Trying key ${ki + 1}/${keysToTry.length}...`);
              jsonString = await stegoCrypto.decryptPayload(bytes, key);
              addStegoLog(`Key ${ki + 1} succeeded! JSON len: ${jsonString.length}`);
              lastErr = null;
              break;
            } catch (e) {
              lastErr = e instanceof Error ? e : new Error(String(e));
              addStegoLog(`Key ${ki + 1} failed: ${lastErr.message}`);
            }
          }
          if (!jsonString && lastErr) {
            addStegoLog("All keys failed, trying app-level decrypt...");
            try {
              jsonString = await stegoCrypto.decryptApp(bytes);
              addStegoLog(`App decrypt succeeded! JSON len: ${jsonString.length}`);
              const parsed = JSON.parse(jsonString);
              if (typeof parsed === "object" && parsed !== null && Array.isArray(parsed.events)) lastErr = null;
            } catch (e2) {
              addStegoLog(`App decrypt failed: ${e2 instanceof Error ? e2.message : String(e2)}`);
            }
          }
          if (!jsonString) {
            addStegoLog(`FAIL: Decryption failed - ${lastErr?.message || "unknown error"}`);
            throw lastErr ?? new Error("Decryption failed");
          }
          addStegoLog(`Decryption complete, parsing JSON...`);
        } else if (raw.trimStart().startsWith("{")) {
          jsonString = raw;
        } else {
          setDecodeError("Invalid payload");
          return;
        }
        const bundle = JSON.parse(jsonString) as NostrStateBundle;
        if (!Array.isArray(bundle.events)) {
          setDecodeError("Invalid payload");
          return;
        }
        const normalized = bundle.events.map((e) => ({
          ...e,
          kind: typeof e.kind === "number" ? e.kind : parseInt(String(e.kind), 10) || 1,
          created_at: typeof e.created_at === "number" ? e.created_at : Math.floor(Date.now() / 1000),
        }));
        setEvents((prev) => {
          const byId = new Map(prev.map((e) => [e.id, e]));
          normalized.forEach((e) => byId.set(e.id, e));
          return Array.from(byId.values()).sort((a, b) => b.created_at - a.created_at);
        });
        const profileUpdates: Record<string, ProfileData> = {};
        bundle.events.filter((e) => e.kind === 0).forEach((e) => {
          try {
            const c = JSON.parse(e.content) as { name?: string; display_name?: string; about?: string; picture?: string; banner?: string; nip05?: string };
            profileUpdates[e.pubkey] = { name: c.name ?? c.display_name, about: c.about, picture: c.picture, banner: c.banner, nip05: c.nip05 };
          } catch (_) {}
        });
        if (Object.keys(profileUpdates).length > 0) setProfiles((p) => ({ ...p, ...profileUpdates }));
        setImportedEventIds((prev) => {
          const next = new Set(prev);
          bundle.events.forEach((e) => next.add(e.id));
          if (next.size > 2000) return new Set([...next].slice(-2000));
          return next;
        });
        setDecodeError("");
        setStatus(`Loaded ${bundle.events.length} events from image.`);
        addStegoLog(`SUCCESS - Loaded ${bundle.events.length} events!`);
        logger.logAction("detect_completed", `Loaded ${bundle.events.length} events`, { name: file.name, eventCount: bundle.events.length });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[App] Detect error:", e);
        setDecodeError(msg);
        logger.logAction("detect_error", msg, { name: file.name });
      } finally {
        setDetecting(false);
        setStegoProgress("");
      }
      return;
    }
    let path: string | null;
    const tauri = await getTauri();
    if (providedPathOrFile === undefined || typeof providedPathOrFile !== "string") {
      setDetecting(true);
      try {
        path = await tauri.openDialog({
          multiple: false,
          filters: [
            { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] },
            { name: "PNG", extensions: ["png"] },
            { name: "JPEG", extensions: ["jpg", "jpeg"] },
          ],
        });
      } finally {
        setDetecting(false);
      }
      if (!path || typeof path !== "string") {
        setStatus("Cancelled");
        logger.logAction("detect_cancelled", "User cancelled detect file dialog");
        return;
      }
    } else {
      path = providedPathOrFile;
      if (!path || typeof path !== "string") return;
    }
    setDetecting(true);
    addStegoLog(`Selected: ${path}`);
    logger.logAction("detect_started", "Decoding stego image", { path });
    try {
      const isJpeg = /\.jpe?g$/i.test(path);
      let result: { ok: boolean; payload?: string; error?: string } = { ok: false };
      // TypeScript codecs first (same code as the web build), so images made by
      // the robust method open on desktop; the Rust decoders remain as fallback.
      try {
        setStegoProgress("Extracting hidden data...");
        const bytes = await tauri.invoke<number[]>("read_bytes", { path });
        const asFile = new File([new Uint8Array(bytes)], path.replace(/^.*[/\\]/, ""), { type: isJpeg ? "image/jpeg" : "image/png" });
        const ts = await decodeAny(asFile, (line) => addStegoLog(line));
        if (ts.ok && ts.payload) result = { ok: true, payload: ts.payload };
      } catch (e) {
        addStegoLog(`TypeScript decode unavailable: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!result.ok) {
        setStegoProgress("Extracting hidden data (Dot decode)...");
        addStegoLog("Running Dot steganography decode...");
        result = await tauri.invoke<{ ok: boolean; payload?: string; error?: string }>("decode_stego_dot", { path });
      }
      console.log("[Detect] Dot result: ok=", result.ok, "error=", result.error ?? "(none)");
      if (!result.ok) {
        addStegoLog(`Dot decode failed: ${result.error ?? "unknown error"}`);
        if (isJpeg) {
          addStegoLog("Falling back to QIM decode (JPEG)...");
          console.log("[Detect] JPEG: falling back to QIM decode:", path);
          result = await tauri.invoke<{ ok: boolean; payload?: string; error?: string }>("decode_stego_qim", { path });
          console.log("[Detect] QIM result: ok=", result.ok, "error=", result.error ?? "(none)", "payloadLen=", result.payload?.length ?? 0);
        } else {
          addStegoLog("Falling back to DWT decode (PNG/other)...");
          console.log("[Detect] PNG/other: falling back to DWT decode:", path);
          result = await tauri.invoke<{ ok: boolean; payload?: string; error?: string }>("decode_stego_image", { path });
          console.log("[Detect] DWT result: ok=", result.ok, "error=", result.error ?? "(none)");
        }
      }
      if (!result.ok || !result.payload) {
        const err = result.error || "Decode failed";
        addStegoLog(`FAIL: ${err}`);
        setDecodeError(err);
        logger.logAction("detect_error", err, { path });
        return;
      }
      addStegoLog(`Dot decode OK! Payload: ${result.payload.length} chars`);
      let jsonString: string;
      const raw = result.payload;
      if (raw.startsWith("base64:")) {
        const bytes = Uint8Array.from(atob(raw.slice(7)), (c) => c.charCodeAt(0));
        if (!stegoCrypto.isEncryptedPayload(bytes)) {
          addStegoLog("FAIL: Not a Stegstr encrypted image");
          setDecodeError("Not a Stegstr encrypted image");
          logger.logAction("detect_error", "Not a Stegstr encrypted image", { path });
          return;
        }
        let keysToTry = identities
          .filter((i) => viewingPubkeys.has(Nostr.getPublicKey(Nostr.hexToBytes(i.privKeyHex))))
          .map((i) => i.privKeyHex);
        if (keysToTry.length === 0) keysToTry = [effectivePrivKey];
        let lastErr: Error | null = null;
        jsonString = "";
        for (const key of keysToTry) {
          try {
            jsonString = await stegoCrypto.decryptPayload(bytes, key);
            lastErr = null;
            break;
          } catch (e) {
            lastErr = e instanceof Error ? e : new Error(String(e));
          }
        }
        if (!jsonString && lastErr) {
          try {
            jsonString = await stegoCrypto.decryptApp(bytes);
            const parsed = JSON.parse(jsonString);
            if (typeof parsed === "object" && parsed !== null && Array.isArray(parsed.events)) lastErr = null;
          } catch (_) {}
        }
        if (!jsonString) throw lastErr ?? new Error("Decryption failed");
      } else if (raw.trimStart().startsWith("{")) {
        jsonString = raw;
      } else {
        setDecodeError("Invalid payload");
        logger.logAction("detect_error", "Invalid payload", { path });
        return;
      }
      const bundle = JSON.parse(jsonString) as NostrStateBundle;
      if (!Array.isArray(bundle.events)) {
        setDecodeError("Invalid payload");
        logger.logAction("detect_error", "Invalid payload (events not array)", { path });
        return;
      }
      const normalized = bundle.events.map((e) => ({
        ...e,
        kind: typeof e.kind === "number" ? e.kind : parseInt(String(e.kind), 10) || 1,
        created_at: typeof e.created_at === "number" ? e.created_at : Math.floor(Date.now() / 1000),
      }));
      setEvents((prev) => {
        const byId = new Map(prev.map((e) => [e.id, e]));
        normalized.forEach((e) => byId.set(e.id, e));
        return Array.from(byId.values()).sort((a, b) => b.created_at - a.created_at);
      });
      const profileUpdates: Record<string, ProfileData> = {};
      bundle.events.filter((e) => e.kind === 0).forEach((e) => {
        try {
          const raw = JSON.parse(e.content) as { name?: string; display_name?: string; about?: string; picture?: string; banner?: string; nip05?: string };
          profileUpdates[e.pubkey] = {
            name: raw.name ?? raw.display_name,
            about: raw.about,
            picture: raw.picture,
            banner: raw.banner,
            nip05: raw.nip05,
          };
        } catch (_) {}
      });
      if (Object.keys(profileUpdates).length > 0) {
        setProfiles((p) => ({ ...p, ...profileUpdates }));
      }
      setImportedEventIds((prev) => {
        const next = new Set(prev);
        bundle.events.forEach((e) => next.add(e.id));
        if (next.size > 2000) {
          const arr = [...next];
          arr.splice(0, arr.length - 2000);
          return new Set(arr);
        }
        return next;
      });
      setView("feed");
      setFeedFilter("global");
      setSearchQuery("");
      setStatus(`Loaded ${bundle.events.length} events`);
      addStegoLog(`SUCCESS - Loaded ${bundle.events.length} events!`);
      logger.logAction("detect_completed", `Loaded ${bundle.events.length} events`, { path, eventCount: bundle.events.length });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isTauriBridgeError = /undefined.*invoke|__TAURI_INTERNALS__/i.test(String(msg));
      setDecodeError(
        isTauriBridgeError
          ? "Detect requires the Stegstr desktop app. Run: npm run tauri dev (not in a browser)"
          : msg
      );
      logger.logError("Detect failed", e, { path });
    } finally {
      setDetecting(false);
      setStegoProgress("");
    }
  }, [effectivePrivKey, identities, viewingPubkeys, addStegoLog]);

  const handleSaveToImage = useCallback(() => {
    setDecodeError("");
    setStegoLogs([]);
    if (isWeb()) setEmbedCoverFile(null);
    setEmbedModalOpen(true);
  }, []);

  const handleDetectFromExchange = useCallback(async () => {
    if (isWeb()) return;
    try {
      const tauri = await getTauri();
      const path = await tauri.invoke<string>(embedMethod === "qim" ? "get_exchange_path_qim" : "get_exchange_path");
      handleLoadFromImage(path);
    } catch (e) {
      setDecodeError(e instanceof Error ? e.message : String(e));
    }
  }, [handleLoadFromImage, embedMethod]);

  const handleEmbedToExchange = useCallback(async () => {
    if (isWeb() || !profile) return;
    setDecodeError("");
    setDetecting(true);
    logger.logAction("embed_started", "Embed to exchange (quick test)", { eventCount: events.length });
    try {
      const tauri = await getTauri();
      const coverPath = await tauri.openDialog({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
      });
      if (!coverPath || typeof coverPath !== "string") {
        setDetecting(false);
        return;
      }
      const useQim = embedMethod === "qim";
      const outputPath = await tauri.invoke<string>(useQim ? "get_exchange_path_qim" : "get_exchange_path");
      const bundle: NostrStateBundle = { version: STEGSTR_BUNDLE_VERSION, events };
      const jsonString = JSON.stringify(bundle);
      const encrypted = await stegoCrypto.encryptOpen(jsonString);
      const payloadToEmbed = "base64:" + uint8ArrayToBase64(encrypted);
      const cmd = useQim ? "encode_stego_qim" : "encode_stego_dot";
      const result = await tauri.invoke<{ ok: boolean; path?: string; error?: string }>(cmd, {
        coverPath,
        outputPath,
        payload: payloadToEmbed,
      });
      if (result.ok && result.path) {
        if (!useQim) {
          try {
            const isPng = await tauri.invoke<boolean>("check_png_signature", { path: result.path });
            addStegoLog(`PNG signature check: ${isPng ? "OK" : "FAIL"}`);
          } catch (e) {
            addStegoLog(`PNG signature check error: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        addStegoLog(`Saved to: ${result.path}`);
        setStatus(`Saved to exchange. B can click Detect from exchange.`);
        logger.logAction("embed_completed", "Embed to exchange done", { path: result.path, eventCount: events.length });
      } else {
        setDecodeError(result.error || "Encode failed");
      }
    } catch (e) {
      setDecodeError(e instanceof Error ? e.message : String(e));
      logger.logError("Embed to exchange failed", e, {});
    } finally {
      setDetecting(false);
    }
  }, [profile, events, embedMethod]);

  const handleEmbedConfirm = useCallback(async () => {
    if (!embedModalOpen) return;
    setDecodeError("");
    setEmbedding(true);
    setStegoProgress("Preparing data...");
    addStegoLog("Starting embed flow...");
    logger.logAction("embed_started", "Starting embed flow", { eventCount: events.length });
    try {
      if (isWeb()) {
        if (!embedCoverFile) {
          setDecodeError("Choose an image first.");
          setEmbedding(false);
          addStegoLog("Error: No image selected");
          return;
        }
        addStegoLog(`Cover image: ${embedCoverFile.name} (${embedCoverFile.size} bytes)`);
        const pubkeysInEmbed = new Set(events.flatMap((e) => [e.pubkey, ...e.tags.filter((t) => t[0] === "p").map((t) => t[1])]));
        const kind0InEvents = new Set(events.filter((e) => e.kind === 0).map((e) => e.pubkey));
        const syntheticKind0: NostrEvent[] = [];
        for (const pk of pubkeysInEmbed) {
          if (!pk || kind0InEvents.has(pk)) continue;
          const idForPk = identities.find((i) => Nostr.getPublicKey(Nostr.hexToBytes(i.privKeyHex)) === pk);
          if (!idForPk) continue;
          const prof = profiles[pk];
          if (!prof) continue;
          try {
            const content = JSON.stringify(prof);
            const ev = await Nostr.finishEventAsync(
              { kind: 0, content, tags: [], created_at: Math.floor(Date.now() / 1000) },
              Nostr.hexToBytes(idForPk.privKeyHex)
            );
            syntheticKind0.push(ev as NostrEvent);
          } catch (_) {}
        }
        const buildBundle = async (eventList: NostrEvent[]) => {
          const pubkeysInEmbed = new Set(
            eventList.flatMap((e) => [e.pubkey, ...e.tags.filter((t) => t[0] === "p").map((t) => t[1])])
          );
          const kind0InEvents = new Set(eventList.filter((e) => e.kind === 0).map((e) => e.pubkey));
          const synthetic: NostrEvent[] = [];
          for (const pk of pubkeysInEmbed) {
            if (!pk || kind0InEvents.has(pk)) continue;
            const idForPk = identities.find((i) => Nostr.getPublicKey(Nostr.hexToBytes(i.privKeyHex)) === pk);
            if (!idForPk) continue;
            const prof = profiles[pk];
            if (!prof) continue;
            try {
              const content = JSON.stringify(prof);
              const ev = await Nostr.finishEventAsync(
                { kind: 0, content, tags: [], created_at: Math.floor(Date.now() / 1000) },
                Nostr.hexToBytes(idForPk.privKeyHex)
              );
              synthetic.push(ev as NostrEvent);
            } catch (_) {}
          }
          return { version: STEGSTR_BUNDLE_VERSION, events: [...synthetic, ...eventList] } as NostrStateBundle;
        };
        // Helper: encrypt and fit payload to capacity, trimming events if needed
        const encryptAndFit = async (maxPayloadBytes: number) => {
          let trimmedEvents = [...events];
          let encrypted: Uint8Array | null = null;
          while (true) {
            const bundle = await buildBundle(trimmedEvents);
            const jsonString = JSON.stringify(bundle);
            addStegoLog(`Bundle: ${trimmedEvents.length} events, ${jsonString.length} bytes JSON`);
            if (embedRecipientMode === "recipients" && embedRecipients.length > 0 && effectivePrivKey) {
              const selfPk = Nostr.getPublicKey(Nostr.hexToBytes(effectivePrivKey));
              const allRecipients = Array.from(new Set([selfPk, ...embedRecipients]));
              addStegoLog(`Encrypting for ${allRecipients.length} recipient(s)...`);
              encrypted = await stegoCrypto.encryptForRecipients(jsonString, effectivePrivKey, allRecipients);
            } else {
              addStegoLog("Encrypting for any Stegstr user...");
              encrypted = await stegoCrypto.encryptOpen(jsonString);
            }
            if (!maxPayloadBytes || encrypted.length <= maxPayloadBytes) break;
            if (trimmedEvents.length === 0) break;
            trimmedEvents = trimmedEvents.slice(0, -1);
          }
          if (!encrypted || (maxPayloadBytes && encrypted.length > maxPayloadBytes)) {
            return null;
          }
          if (trimmedEvents.length < events.length) {
            addStegoLog(`Trimmed events: kept ${trimmedEvents.length}/${events.length} to fit capacity`);
          }
          addStegoLog(`Encrypted: ${encrypted.length} bytes`);
          return encrypted;
        };

        if (embedMethod === "robust") {
          // ===== ROBUST (STDM) BRANCH — from #71 =====
          // No pre-resize step: the encoder normalises the image internally,
          // so the destination platform does not have to be guessed.
          addStegoLog(`Using robust encoder (mode: ${stegoMode})`);
          const capacity = await getStdmCapacityForFile(embedCoverFile, stegoMode);
          addStegoLog(`Capacity: ${capacity.capacityBytes} bytes (${capacity.width}x${capacity.height})`);
          if (!capacity.usable) {
            setDecodeError(`Image too small for this mode: shortest edge is ${Math.min(capacity.width, capacity.height)}px, needs ${capacity.minEdge}px`);
            setEmbedding(false);
            return;
          }
          const encrypted = await encryptAndFit(stdmPayloadBytes(MODES[stegoMode]));
          if (!encrypted) {
            setDecodeError("Payload does not fit this mode (try a larger payload mode or fewer events)");
            setEmbedding(false);
            return;
          }
          setStegoProgress("Embedding data into image...");
          let blob: Blob;
          try {
            blob = await encodeStdmImageFile(embedCoverFile, encrypted, stegoMode);
            addStegoLog(`Encode complete: ${blob.size} bytes JPEG`);
          } catch (e) {
            setDecodeError(`Encode failed: ${e instanceof Error ? e.message : String(e)}`);
            setEmbedding(false);
            return;
          }
          // Read it back before claiming success, so a silent failure surfaces
          // here rather than at the recipient.
          setStegoProgress("Verifying embed integrity (self-test)...");
          const selfTestResult = await stdmSelfTest(blob, encrypted, stegoMode);
          if (!selfTestResult.ok) {
            addStegoLog(`Self-test FAILED: ${selfTestResult.error}`);
            setDecodeError(`Embed verification failed: ${selfTestResult.error}`);
            setEmbedding(false);
            return;
          }
          addStegoLog("Self-test PASSED - payload reads back byte for byte.");
          const name = embedCoverFile.name.replace(/\.[^.]+$/, "") || "image";
          setStegoProgress("Downloading embedded image...");
          downloadBlob(blob, `${name}-stegstr.jpg`);
          addStegoLog("SUCCESS - Download started!");
          setEmbedModalOpen(false);
          setEmbedCoverFile(null);
          setEmbedding(false);
          setStegoProgress("");
          setStatus("Image downloaded. Save it from your Downloads folder.");
          logger.logAction("embed_completed", "Robust embed saved (browser download)", { eventCount: events.length, mode: stegoMode });
          return;
        }

        if (embedMethod === "qim") {
          // ===== QIM BRANCH =====
          addStegoLog(`Using QIM method (target platform: ${targetPlatform})`);

          // Step 1: Pre-resize cover for platform
          setStegoProgress("Pre-resizing image for target platform...");
          const platformWidth = PLATFORM_WIDTHS[targetPlatform] ?? PLATFORM_WIDTHS[DEFAULT_PLATFORM];
          let resizedCover: File;
          try {
            resizedCover = await resizeCoverForPlatform(embedCoverFile, platformWidth);
            addStegoLog(`Resized cover: ${resizedCover.name} (${resizedCover.size} bytes)`);
          } catch (e) {
            setDecodeError(`Resize failed: ${e instanceof Error ? e.message : String(e)}`);
            setEmbedding(false);
            return;
          }

          // Step 2: Check QIM capacity
          const { capacityBytes: maxPayloadBytes, width: resW, height: resH } = await getQimCapacityForFile(embedCoverFile, targetPlatform);
          addStegoLog(`QIM capacity: ${maxPayloadBytes} bytes (${resW}x${resH})`);

          // Step 3: Encrypt and fit payload
          const encrypted = await encryptAndFit(maxPayloadBytes);
          if (!encrypted) {
            setDecodeError("Image too small for stego payload (try a larger image or fewer events)");
            setEmbedding(false);
            return;
          }

          // Step 4: QIM embed
          setStegoProgress("Embedding data into image (QIM encode)...");
          addStegoLog("Running QIM steganography encode...");
          let blob: Blob;
          try {
            blob = await encodeQimImageFile(resizedCover, encrypted);
            addStegoLog(`QIM encode complete! Output: ${blob.size} bytes JPEG`);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            setDecodeError(`QIM encode failed: ${msg}`);
            setEmbedding(false);
            return;
          }

          // Step 5: Round-trip self-test
          setStegoProgress("Verifying embed integrity (self-test)...");
          addStegoLog("Running round-trip self-test...");
          const selfTestResult = await qimSelfTest(blob, encrypted);
          if (selfTestResult.ok) {
            addStegoLog("Self-test PASSED! Payload survives encode/decode round-trip.");
          } else {
            addStegoLog(`Self-test FAILED: ${selfTestResult.error}`);
            addStegoLog("WARNING: Payload may not survive platform transforms. Consider using Dot method instead.");
          }

          // Step 6: Download
          const name = embedCoverFile.name.replace(/\.[^.]+$/, "") || "image";
          setStegoProgress("Downloading embedded image...");
          addStegoLog(`Triggering download: ${name}-stegstr.jpg`);
          downloadBlob(blob, `${name}-stegstr.jpg`);
          addStegoLog("SUCCESS - Download started!");
          setEmbedModalOpen(false);
          setEmbedCoverFile(null);
          setEmbedding(false);
          setStegoProgress("");
          setStatus("Image downloaded. Save it from your Downloads folder.");
          logger.logAction("embed_completed", "QIM embed saved (browser download)", { eventCount: events.length, platform: targetPlatform });
          return;
        }

        // ===== DOT BRANCH (legacy) =====
        const maxPayloadBytes = await getDotCapacityForFile(embedCoverFile);
        addStegoLog(`Dot capacity: ${maxPayloadBytes} bytes`);
        const encrypted = await encryptAndFit(maxPayloadBytes);
        if (!encrypted) {
          setDecodeError("Image too small for stego payload");
          setEmbedding(false);
          return;
        }
        const payloadToEmbed = "base64:" + uint8ArrayToBase64(encrypted);
        setStegoProgress("Embedding data into image (Dot encode)...");
        addStegoLog("Running Dot steganography encode...");
        const blob = await encodeStegoToBlob(embedCoverFile, payloadToEmbed);
        addStegoLog(`Dot encode complete! Output: ${blob.size} bytes PNG`);
        const name = embedCoverFile.name.replace(/\.[^.]+$/, "") || "image";
        setStegoProgress("Downloading embedded image...");
        addStegoLog(`Triggering download: ${name}-stegstr.png`);
        downloadBlob(blob, `${name}-stegstr.png`);
        addStegoLog("SUCCESS - Download started!");
        setEmbedModalOpen(false);
        setEmbedCoverFile(null);
        setEmbedding(false);
        setStegoProgress("");
        setStatus("Image downloaded. Save it from your Downloads folder.");
        logger.logAction("embed_completed", "Dot embed saved (browser download)", { eventCount: events.length });
        return;
      }
      const tauri = await getTauri();
      const coverPath = await tauri.openDialog({
        multiple: false,
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
      });
      if (!coverPath || typeof coverPath !== "string") {
        setEmbedModalOpen(false);
        return;
      }
      const coverName = coverPath.replace(/^.*[/\\]/, "").replace(/\.[^.]+$/, "") || "image";
      // QIM (JPEG, DCT-domain) survives WhatsApp/Instagram/Telegram recompression
      // and doesn't paint visible pixel artifacts into the image, unlike Dot
      // (PNG, spatial-domain) -- default to it, matching the web build's default.
      const useQim = embedMethod === "qim";
      const useRobust = embedMethod === "robust";
      const ext = useQim || useRobust ? "jpg" : "png";
      let defaultPath = `${coverName}.${ext}`;
      try {
        const desktop = await tauri.invoke<string>("get_desktop_path");
        if (desktop) defaultPath = `${desktop}/${coverName}.${ext}`;
      } catch (_) {}
      const outputPath = await tauri.saveDialog({
        filters: [{ name: ext === "jpg" ? "JPEG" : "PNG", extensions: [ext] }],
        defaultPath,
      });
      if (!outputPath) {
        setEmbedModalOpen(false);
        return;
      }
      const finalOutputPath = outputPath.endsWith(`.${ext}`) ? outputPath : outputPath + `.${ext}`;
      let maxPayloadBytes = 0;
      try {
        if (useRobust) {
          maxPayloadBytes = stdmPayloadBytes(MODES[stegoMode]);
          addStegoLog(`Robust capacity (${stegoMode} mode): ${maxPayloadBytes} bytes`);
        } else {
          maxPayloadBytes = await tauri.invoke<number>(useQim ? "get_qim_capacity" : "get_dot_capacity", { path: coverPath });
          addStegoLog(`${useQim ? "QIM" : "Dot"} capacity: ${maxPayloadBytes} bytes`);
        }
      } catch (e) {
        addStegoLog(`Capacity check failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const buildBundle = async (eventList: NostrEvent[]) => {
        const pubkeysInEmbed = new Set(
          eventList.flatMap((e) => [e.pubkey, ...e.tags.filter((t) => t[0] === "p").map((t) => t[1])])
        );
        const kind0InEvents = new Set(eventList.filter((e) => e.kind === 0).map((e) => e.pubkey));
        const syntheticKind0: NostrEvent[] = [];
        for (const pk of pubkeysInEmbed) {
          if (!pk || kind0InEvents.has(pk)) continue;
          const idForPk = identities.find((i) => Nostr.getPublicKey(Nostr.hexToBytes(i.privKeyHex)) === pk);
          if (!idForPk) continue;
          const prof = profiles[pk];
          if (!prof) continue;
          try {
            const content = JSON.stringify(prof);
            const ev = await Nostr.finishEventAsync(
              { kind: 0, content, tags: [], created_at: Math.floor(Date.now() / 1000) },
              Nostr.hexToBytes(idForPk.privKeyHex)
            );
            syntheticKind0.push(ev as NostrEvent);
          } catch (_) {}
        }
        return { version: STEGSTR_BUNDLE_VERSION, events: [...syntheticKind0, ...eventList] } as NostrStateBundle;
      };
      let trimmedEvents = [...events];
      let jsonString = "";
      let payloadBytes: Uint8Array | null = null;
      while (true) {
        const bundle = await buildBundle(trimmedEvents);
        jsonString = JSON.stringify(bundle);
        const encrypted = await stegoCrypto.encryptOpen(jsonString);
        if (!maxPayloadBytes || encrypted.length <= maxPayloadBytes) {
          payloadBytes = encrypted;
          break;
        }
        if (trimmedEvents.length === 0) break;
        trimmedEvents = trimmedEvents.slice(0, -1);
      }
      if (!payloadBytes) {
        setDecodeError("Image too small for stego payload");
        return;
      }
      if (trimmedEvents.length < events.length) {
        addStegoLog(`Trimmed events: kept ${trimmedEvents.length}/${events.length} to fit capacity`);
      }
      if (useRobust) {
        // Desktop robust path runs the same TypeScript codec as the web build
        // (merge plan D2): read the cover through the app, encode in the webview,
        // write the result where the user chose.
        setStegoProgress("Embedding data into image (robust)...");
        const coverBytes = await tauri.invoke<number[]>("read_bytes", { path: coverPath });
        const coverFile = new File([new Uint8Array(coverBytes)], coverPath.replace(/^.*[/\\]/, ""), { type: "image/jpeg" });
        const capacity = await getStdmCapacityForFile(coverFile, stegoMode);
        if (!capacity.usable) {
          setDecodeError(`Image too small for this mode: shortest edge is ${Math.min(capacity.width, capacity.height)}px, needs ${capacity.minEdge}px`);
          return;
        }
        const blob = await encodeStdmImageFile(coverFile, payloadBytes, stegoMode);
        setStegoProgress("Verifying embed integrity (self-test)...");
        const check = await stdmSelfTest(blob, payloadBytes, stegoMode);
        if (!check.ok) {
          setDecodeError(`Embed verification failed: ${check.error}`);
          return;
        }
        addStegoLog("Self-test PASSED - payload reads back byte for byte.");
        const savedPath = await tauri.invoke<string>("write_bytes", { path: finalOutputPath, data: Array.from(new Uint8Array(await blob.arrayBuffer())) });
        setEmbedModalOpen(false);
        addStegoLog(`Saved to: ${savedPath}`);
        setStatus(`Saved to ${savedPath}. Finder opened.`);
        logger.logAction("embed_completed", "Robust embed saved", { path: savedPath, eventCount: events.length, mode: stegoMode });
        try {
          await tauri.invoke("reveal_in_finder", { path: savedPath });
        } catch (_) {}
        return;
      }
      const payloadToEmbed = "base64:" + uint8ArrayToBase64(payloadBytes);
      setStegoProgress(useQim ? "Embedding with QIM (JPEG, survives recompression)..." : "Embedding with Dot (offset, robust)...");
      const cmd = useQim ? "encode_stego_qim" : "encode_stego_dot";
      const result = await tauri.invoke<{ ok: boolean; path?: string; error?: string }>(cmd, {
        coverPath,
        outputPath: finalOutputPath,
        payload: payloadToEmbed,
      });
      setEmbedModalOpen(false);
      if (result.ok && result.path) {
        if (!useQim) {
          try {
            const isPng = await tauri.invoke<boolean>("check_png_signature", { path: result.path });
            addStegoLog(`PNG signature check: ${isPng ? "OK" : "FAIL"}`);
          } catch (e) {
            addStegoLog(`PNG signature check error: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        addStegoLog(`Saved to: ${result.path}`);
        setStatus(`Saved to ${result.path}. Finder opened.`);
        logger.logAction("embed_completed", "Embed saved successfully", { path: result.path, eventCount: events.length });
        try {
          await tauri.invoke("reveal_in_finder", { path: result.path });
        } catch (_) {}
      } else {
        const err = result.error || "Encode failed";
        setDecodeError(err);
        logger.logAction("embed_error", err, { coverPath, outputPath: finalOutputPath });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[App] Embed error:", e);
      setDecodeError(msg);
      logger.logError("Embed failed", e, {});
      setEmbedModalOpen(false);
    } finally {
      setEmbedding(false);
      setStegoProgress("");
    }
  }, [embedModalOpen, embedCoverFile, events, profiles, identities, addStegoLog, embedRecipientMode, embedRecipients, effectivePrivKey, embedMethod, targetPlatform, stegoMode]);

  useEffect(() => {
    if (isWeb()) return;
    let unlisten: (() => void) | null = null;
    getTauri()
      .then((t) => t.getCurrentWindow().onDragDropEvent((event) => {
        if (event.payload.type === "drop" && event.payload.paths?.length) {
          handleLoadFromImage(event.payload.paths[0]);
        }
      }))
      .then((fn) => { unlisten = fn; })
      .catch(() => {});
    return () => { unlisten?.(); };
  }, [handleLoadFromImage]);

  return { addStegoLog, decodeError, stegoMode, setStegoMode, detecting, dragOverStego, embedCoverFile, embedMethod, embedModalOpen, embedRecipientInput, embedRecipientMode, embedRecipients, embedding, handleDetectFromExchange, handleEmbedConfirm, handleEmbedToExchange, handleLoadFromImage, handleSaveToImage, importedEventIds, setDecodeError, setDetecting, setDragOverStego, setEmbedCoverFile, setEmbedMethod, setEmbedModalOpen, setEmbedRecipientInput, setEmbedRecipientMode, setEmbedRecipients, setEmbedding, setImportedEventIds, setStegoLogs, setStegoProgress, setTargetPlatform, stegoLogs, stegoProgress, targetPlatform };
}
