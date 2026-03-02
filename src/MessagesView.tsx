import type { NostrEvent, ProfileData } from "./types";

export interface MessagesViewProps {
  dmEvents: NostrEvent[];
  selfPubkeys: string[];
  dmDecrypted: Record<string, string>;
  profiles: Record<string, ProfileData>;
  lastReadTimestamps: Record<string, number>;
  recentDmPartners: { pubkey: string }[];
  selectedMessagePeer: string | null;
  setSelectedMessagePeer: React.Dispatch<React.SetStateAction<string | null>>;
  myName: string;
  dmReplyContent: string;
  setDmReplyContent: React.Dispatch<React.SetStateAction<string>>;
  handleSendDm: (peerPk: string, content: string) => void;
  onNewMessage: () => void;
}

export function MessagesView({
  dmEvents, selfPubkeys, dmDecrypted, profiles, lastReadTimestamps,
  recentDmPartners, selectedMessagePeer, setSelectedMessagePeer,
  myName, dmReplyContent, setDmReplyContent, handleSendDm, onNewMessage,
}: MessagesViewProps) {
  const getThread = (peerPk: string) =>
    dmEvents
      .filter((ev) => {
        const other = selfPubkeys.includes(ev.pubkey) ? ev.tags.find((t) => t[0] === "p")?.[1] : ev.pubkey;
        return other === peerPk;
      })
      .sort((a, b) => a.created_at - b.created_at);

  return (
    <section className="messages-view">
      <h2>Messages</h2>
      <p className="muted">Nostr DMs when Network is ON; you can also message any pubkey (npub or hex) and share via Embed image.</p>
      <div className="messages-layout">
        <div className="conversation-list-wrap">
          <button type="button" className="btn-new-message btn-primary" onClick={onNewMessage}>New message</button>
          <ul className="conversation-list">
            {recentDmPartners.map(({ pubkey: pk }) => {
              const thread = getThread(pk);
              const last = thread[thread.length - 1];
              const preview = last ? (dmDecrypted[last.id] ?? "[Decrypting…]").slice(0, 60) : "";
              const name = profiles[pk]?.name ?? `${pk.slice(0, 8)}…`;
              const lastRead = lastReadTimestamps[pk] ?? 0;
              const peerUnread = dmEvents.filter((ev) => !selfPubkeys.includes(ev.pubkey) && ev.pubkey === pk && ev.created_at > lastRead).length;
              return (
                <li key={pk} className={selectedMessagePeer === pk ? "active" : ""}>
                  <button type="button" className="conversation-item" onClick={() => setSelectedMessagePeer(pk)}>
                    <span className="conversation-name">{name}{peerUnread > 0 && <span className="nav-badge">{peerUnread}</span>}</span>
                    <span className="conversation-preview muted">{preview || "No messages"}</span>
                  </button>
                </li>
              );
            })}
          </ul>
          {recentDmPartners.length === 0 && (
            <p className="muted">No conversations yet. Use New message to start one (npub or hex pubkey).</p>
          )}
        </div>
        <div className="thread-wrap">
          {selectedMessagePeer ? (() => {
            const peerPk = selectedMessagePeer;
            const thread = getThread(peerPk);
            const peerName = profiles[peerPk]?.name ?? `${peerPk.slice(0, 8)}…${peerPk.slice(-4)}`;
            return (
              <>
                <div className="thread-header">
                  <strong>Conversation with {peerName}</strong>
                  <button type="button" className="btn-back" onClick={() => setSelectedMessagePeer(null)}>← Back</button>
                </div>
                <ul className="thread-messages">
                  {thread.map((ev) => {
                    const isFromThem = !selfPubkeys.includes(ev.pubkey);
                    const content = dmDecrypted[ev.id] ?? "[Decrypting…]";
                    const senderName = isFromThem ? (profiles[ev.pubkey]?.name ?? `${ev.pubkey.slice(0, 8)}…`) : myName;
                    return (
                      <li key={ev.id} className={isFromThem ? "msg-from" : "msg-to"}>
                        <span className="msg-meta">{isFromThem ? "From" : "To"} {senderName} · {new Date(ev.created_at * 1000).toLocaleString()}</span>
                        <p className="msg-content">{content}</p>
                      </li>
                    );
                  })}
                </ul>
                <div className="thread-reply">
                  <textarea
                    value={dmReplyContent}
                    onChange={(e) => setDmReplyContent(e.target.value)}
                    placeholder={`Reply to ${peerName}… (Enter to send, Shift+Enter for newline)`}
                    rows={2}
                    className="wide"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        if (dmReplyContent.trim()) handleSendDm(peerPk, dmReplyContent);
                      }
                    }}
                  />
                  <button type="button" className="btn-primary" onClick={() => handleSendDm(peerPk, dmReplyContent)}>Send</button>
                </div>
              </>
            );
          })() : (
            <p className="muted">Select a conversation or start a New message.</p>
          )}
        </div>
      </div>
    </section>
  );
}
