import { contentWithoutImages } from "./utils";
import type { NostrEvent, ProfileData } from "./types";

export interface NotificationsViewProps {
  events: NostrEvent[];
  profiles: Record<string, ProfileData>;
  onNavigateProfile: (pubkey: string) => void;
  onViewPost: (noteId: string) => void;
}

export function NotificationsView({ events, profiles, onNavigateProfile, onViewPost }: NotificationsViewProps) {
  return (
    <section className="notifications-view">
      <h2>Notifications</h2>
      <p className="muted">Reactions and replies to your notes. Click a name to open their profile; click View post to see it in the feed.</p>
      <ul className="event-list">
        {events.map((ev) => {
          const noteIdRef = ev.kind === 7 ? ev.tags.find((t) => t[0] === "e")?.[1] : ev.kind === 6 || ev.kind === 9735 ? ev.tags.find((t) => t[0] === "e")?.[1] : (ev.kind === 1 ? (ev.tags.find((t) => t[0] === "e")?.[1] ?? ev.id) : ev.id);
          return (
            <li key={ev.id} className="event notification-item">
              <span className="event-meta">
                {ev.kind === 7 ? "Like" : ev.kind === 6 ? "Repost" : ev.kind === 9735 ? "Zap" : "Reply"} from{" "}
                <button type="button" className="link-like" onClick={() => onNavigateProfile(ev.pubkey)}>
                  {(profiles[ev.pubkey]?.name ?? `${ev.pubkey.slice(0, 8)}…`)}
                </button>
                {" · "}{new Date(ev.created_at * 1000).toLocaleString()}
              </span>
              {ev.kind === 1 && <p className="event-content">{contentWithoutImages(ev.content).trim() || ev.content}</p>}
              {ev.kind === 7 && <p className="event-content muted">{ev.content || "+"}</p>}
              {ev.kind === 6 && <p className="event-content muted">Reposted your note</p>}
              {ev.kind === 9735 && <p className="event-content muted">Zapped your note</p>}
              {noteIdRef && (
                <button type="button" className="link-like view-post-link" onClick={() => onViewPost(noteIdRef)}>
                  View post
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {events.length === 0 && <p className="muted">No notifications yet.</p>}
    </section>
  );
}
