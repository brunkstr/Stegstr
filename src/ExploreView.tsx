import { NoteThread } from "./NoteCard";
import type { NoteCardActions, NoteCardState } from "./NoteCard";
import type { NostrEvent } from "./types";

export interface ExploreViewProps {
  notes: NostrEvent[];
  getRepliesTo: (noteId: string) => NostrEvent[];
  getLikeCount: (noteId: string) => number;
  state: NoteCardState;
  actions: NoteCardActions;
}

export function ExploreView({ notes, getRepliesTo, getLikeCount, state, actions }: ExploreViewProps) {
  return (
    <section className="explore-view">
      <h2>Explore</h2>
      <p className="muted">Notes with most likes (trending).</p>
      <ul className="note-list">
        {notes.map((ev) => {
          const replies = getRepliesTo(ev.id).sort((a, b) => a.created_at - b.created_at);
          const likeCount = getLikeCount(ev.id);
          return (
            <NoteThread
              key={ev.id}
              event={ev}
              state={state}
              actions={actions}
              replies={replies}
              metaSuffix={<span className="muted"> · {likeCount} like{likeCount !== 1 ? "s" : ""}</span>}
              maxReplies={3}
              showReplyActions={false}
            />
          );
        })}
      </ul>
      {notes.length === 0 && <p className="muted">No notes yet. Turn Network ON for relay feed.</p>}
    </section>
  );
}
